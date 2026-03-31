package update

import "testing"

func TestIsNewerVersion(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		latest  string
		current string
		want    bool
	}{
		{name: "higher patch", latest: "0.1.1", current: "0.1.0", want: true},
		{name: "lower patch", latest: "0.1.0", current: "0.1.1", want: false},
		{name: "same version", latest: "0.1.0", current: "0.1.0", want: false},
		{name: "prefixed tag", latest: "v0.2.0", current: "0.1.9", want: true},
		{name: "git describe current", latest: "0.1.0", current: "v0.1.0-2-gabc123", want: false},
		{name: "invalid current treated as older", latest: "0.1.0", current: "dev", want: true},
		{name: "invalid latest ignored", latest: "dev", current: "0.1.0", want: false},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := isNewerVersion(tt.latest, tt.current)
			if got != tt.want {
				t.Fatalf("isNewerVersion(%q, %q) = %t, want %t", tt.latest, tt.current, got, tt.want)
			}
		})
	}
}
