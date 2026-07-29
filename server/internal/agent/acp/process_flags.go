package acp

const (
	windowsACPCreateNewProcessGroup  = uint32(0x00000200)
	windowsACPCreateDefaultErrorMode = uint32(0x04000000)
	windowsACPCreateNoWindow         = uint32(0x08000000)
)

func windowsACPProcessCreationFlags() uint32 {
	return windowsACPCreateNewProcessGroup | windowsACPCreateDefaultErrorMode | windowsACPCreateNoWindow
}
