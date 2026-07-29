package main

const (
	windowsCreateNewProcessGroup = uint32(0x00000200)
	windowsDetachedProcess       = uint32(0x00000008)
	windowsCreateNoWindow        = uint32(0x08000000)
)

func windowsBackgroundCreationFlags() uint32 {
	return windowsCreateNewProcessGroup | windowsDetachedProcess
}
