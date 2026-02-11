package api

type WSRequest struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type WSResponse struct {
	ID      string           `json:"id,omitempty"`
	Type    string           `json:"type"`
	Payload map[string]any   `json:"payload"`
	Error   *WSResponseError `json:"error,omitempty"`
}

type WSResponseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
