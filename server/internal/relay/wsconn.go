package relay

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const wsBridgeWriteTimeout = 15 * time.Second

type WebSocketNetConn struct {
	conn *websocket.Conn

	readMu  sync.Mutex
	writeMu sync.Mutex

	reader io.Reader
}

func NewWebSocketNetConn(conn *websocket.Conn) net.Conn {
	return &WebSocketNetConn{conn: conn}
}

func (c *WebSocketNetConn) Read(p []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()

	for {
		if c.reader == nil {
			messageType, reader, err := c.conn.NextReader()
			if err != nil {
				return 0, err
			}
			if messageType != websocket.BinaryMessage {
				continue
			}
			c.reader = reader
		}

		n, err := c.reader.Read(p)
		if errors.Is(err, io.EOF) {
			c.reader = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (c *WebSocketNetConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	writer, err := c.conn.NextWriter(websocket.BinaryMessage)
	if err != nil {
		return 0, err
	}
	n, writeErr := writer.Write(p)
	closeErr := writer.Close()
	if writeErr != nil {
		return n, writeErr
	}
	if closeErr != nil {
		return n, closeErr
	}
	return n, nil
}

func (c *WebSocketNetConn) Close() error {
	return c.conn.Close()
}

func (c *WebSocketNetConn) LocalAddr() net.Addr {
	return c.conn.LocalAddr()
}

func (c *WebSocketNetConn) RemoteAddr() net.Addr {
	return c.conn.RemoteAddr()
}

func (c *WebSocketNetConn) SetDeadline(t time.Time) error {
	if err := c.conn.SetReadDeadline(t); err != nil {
		return err
	}
	return c.conn.SetWriteDeadline(t)
}

func (c *WebSocketNetConn) SetReadDeadline(t time.Time) error {
	return c.conn.SetReadDeadline(t)
}

func (c *WebSocketNetConn) SetWriteDeadline(t time.Time) error {
	return c.conn.SetWriteDeadline(t)
}

func bridgeWebSocketToStream(localConn *websocket.Conn, stream io.Writer, errCh chan<- error) {
	for {
		messageType, payload, err := localConn.ReadMessage()
		if err != nil {
			closeCode := websocket.CloseNormalClosure
			closeText := "local_closed"
			if closeErr, ok := err.(*websocket.CloseError); ok {
				closeCode = closeErr.Code
				closeText = closeErr.Text
			}
			_ = writeWSCloseFrame(stream, sanitizeWSCloseCode(closeCode), closeText)
			errCh <- nil
			return
		}
		if err := writeWSDataFrame(stream, messageType, payload); err != nil {
			errCh <- fmt.Errorf("relay local_to_stream write failed: %w", err)
			return
		}
	}
}

func bridgeStreamToWebSocket(stream io.Reader, localConn *websocket.Conn, errCh chan<- error) {
	for {
		frameType, opcode, payload, closeCode, closeText, err := readWSFrame(stream)
		if err != nil {
			if errors.Is(err, io.EOF) {
				errCh <- nil
				return
			}
			errCh <- err
			return
		}

		switch frameType {
		case wsFrameData:
			_ = localConn.SetWriteDeadline(time.Now().Add(wsBridgeWriteTimeout))
			if err := localConn.WriteMessage(opcode, payload); err != nil {
				errCh <- fmt.Errorf("relay stream_to_local websocket write failed: %w", err)
				return
			}
		case wsFrameClose:
			closeCode = sanitizeWSCloseCode(closeCode)
			_ = localConn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(closeCode, closeText),
				time.Now().Add(2*time.Second),
			)
			errCh <- nil
			return
		default:
			errCh <- errors.New("invalid_ws_frame")
			return
		}
	}
}

func writeWSDataFrame(w io.Writer, opcode int, payload []byte) error {
	if err := setWriteDeadline(w, wsBridgeWriteTimeout); err != nil {
		return err
	}
	header := make([]byte, 6)
	header[0] = wsFrameData
	header[1] = byte(opcode)
	binary.BigEndian.PutUint32(header[2:], uint32(len(payload)))
	if _, err := w.Write(header); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}

func writeWSCloseFrame(w io.Writer, code int, reason string) error {
	if err := setWriteDeadline(w, wsBridgeWriteTimeout); err != nil {
		return err
	}
	reasonBytes := []byte(reason)
	if len(reasonBytes) > 65535 {
		reasonBytes = reasonBytes[:65535]
	}
	header := make([]byte, 7)
	header[0] = wsFrameClose
	binary.BigEndian.PutUint16(header[1:], uint16(code))
	binary.BigEndian.PutUint32(header[3:], uint32(len(reasonBytes)))
	if _, err := w.Write(header); err != nil {
		return err
	}
	if len(reasonBytes) == 0 {
		return nil
	}
	_, err := w.Write(reasonBytes)
	return err
}

func setWriteDeadline(w io.Writer, timeout time.Duration) error {
	deadliner, ok := w.(interface {
		SetWriteDeadline(time.Time) error
	})
	if !ok {
		return nil
	}
	return deadliner.SetWriteDeadline(time.Now().Add(timeout))
}

func readWSFrame(r io.Reader) (frameType byte, opcode int, payload []byte, closeCode int, closeText string, err error) {
	var kind [1]byte
	if _, err = io.ReadFull(r, kind[:]); err != nil {
		return 0, 0, nil, 0, "", err
	}

	switch kind[0] {
	case wsFrameData:
		header := make([]byte, 5)
		if _, err = io.ReadFull(r, header); err != nil {
			return 0, 0, nil, 0, "", err
		}
		opcode = int(header[0])
		size := binary.BigEndian.Uint32(header[1:])
		payload = make([]byte, size)
		if _, err = io.ReadFull(r, payload); err != nil {
			return 0, 0, nil, 0, "", err
		}
		return wsFrameData, opcode, payload, 0, "", nil
	case wsFrameClose:
		header := make([]byte, 6)
		if _, err = io.ReadFull(r, header); err != nil {
			return 0, 0, nil, 0, "", err
		}
		closeCode = int(binary.BigEndian.Uint16(header[:2]))
		size := binary.BigEndian.Uint32(header[2:])
		reason := make([]byte, size)
		if _, err = io.ReadFull(r, reason); err != nil {
			return 0, 0, nil, 0, "", err
		}
		return wsFrameClose, 0, nil, closeCode, string(reason), nil
	default:
		return 0, 0, nil, 0, "", errors.New("unknown_ws_frame")
	}
}

func sanitizeWSCloseCode(code int) int {
	switch code {
	case websocket.CloseNoStatusReceived, websocket.CloseAbnormalClosure, websocket.CloseTLSHandshake:
		return websocket.CloseNormalClosure
	default:
		return code
	}
}
