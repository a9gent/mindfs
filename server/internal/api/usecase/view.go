package usecase

import (
	"context"

	"mindfs/server/internal/router"
)

type ListViewRoutesInput struct {
	RootID string
	Path   string
}

type ListViewRoutesOutput struct {
	Routes []router.ResolvedView
}

func (s *Service) ListViewRoutes(_ context.Context, in ListViewRoutesInput) (ListViewRoutesOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListViewRoutesOutput{}, err
	}
	vm, err := s.Registry.GetViewManager(in.RootID)
	if err != nil {
		return ListViewRoutesOutput{}, err
	}
	routes, err := vm.Routes(in.Path)
	if err != nil {
		return ListViewRoutesOutput{}, err
	}
	return ListViewRoutesOutput{Routes: routes}, nil
}

type SetViewPreferenceInput struct {
	RootID  string
	Path    string
	RouteID string
}

func (s *Service) SetViewPreference(_ context.Context, in SetViewPreferenceInput) error {
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	vm, err := s.Registry.GetViewManager(in.RootID)
	if err != nil {
		return err
	}
	return vm.SetPreference(in.Path, in.RouteID)
}
