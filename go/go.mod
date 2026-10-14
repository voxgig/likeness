module github.com/voxgig/likeness/go

go 1.23

require github.com/voxgig-sdk/joplin-sdk/go v0.0.0

require (
	github.com/voxgig/plugin/go v0.0.0-20260901203214-91f294b7a228 // indirect
	github.com/voxgig/sekreto/go v0.0.0 // indirect
	github.com/voxgig/station/go v0.0.1 // indirect
	github.com/voxgig/struct/go v0.0.0 // indirect
	github.com/voxgig/struct/go/testutil v0.0.0-20261009084424-3ab807cc2ae7 // indirect
)

// The generated SDKs are not published to any language registry yet, so the
// pin lives in spec/sources.aontu and `make sdk` puts the clone where this
// points. The same relative layout serves the TypeScript port's `file:`
// dependency, so one `make sdk` satisfies both.
replace github.com/voxgig-sdk/joplin-sdk/go => ../../voxgig-sdk/joplin-sdk/go

// station's Go module has no tag, and requires placeholder versions of its own
// dependencies that only its workspace resolves (voxgig/station#27). Each is
// mapped to a real revision; station's is the one its other ports are pinned at.
replace github.com/voxgig/station/go v0.0.1 => github.com/voxgig/station/go v0.0.0-20260918114619-50667dc650e9

replace github.com/voxgig/sekreto/go v0.0.0 => github.com/voxgig/sekreto/go v0.0.0-20260916220330-32b83acba90a

replace github.com/voxgig/struct/go v0.0.0 => github.com/voxgig/struct/go v0.1.6
