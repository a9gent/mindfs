package usecase

import "golang.org/x/sys/windows"

func listLocalDirVolumes(rootPathMap map[string]string) []LocalDirItem {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	volumes := make([]LocalDirItem, 0, 4)
	for drive := 'A'; drive <= 'Z'; drive++ {
		if mask&(1<<uint(drive-'A')) == 0 {
			continue
		}
		path := string(drive) + `:\`
		item := LocalDirItem{
			Name:  string(drive) + ":",
			Path:  path,
			IsDir: true,
		}
		if rootID, ok := rootPathMap[normalizeLocalDirPath(path)]; ok {
			item.IsAddedRoot = true
			item.RootID = rootID
		}
		volumes = append(volumes, item)
	}
	return volumes
}
