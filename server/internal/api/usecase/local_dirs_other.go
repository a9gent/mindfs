//go:build !windows

package usecase

func listLocalDirVolumes(map[string]string) []LocalDirItem {
	return nil
}
