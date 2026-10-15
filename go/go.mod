module github.com/voxgig/likeness/go

go 1.23.0

require (
	github.com/voxgig-sdk/joplin-sdk/go v0.0.0
	github.com/voxgig-sdk/notion-sdk/go v0.0.0
	github.com/voxgig-sdk/obsidian-sdk/go v0.0.0
	github.com/voxgig/sekreto/go v0.0.0-20260916220330-32b83acba90a
	github.com/voxgig/station/go v0.0.1
	golang.org/x/term v0.33.0
)

require (
	github.com/voxgig/omni/go v0.1.0 // indirect
	github.com/voxgig/plugin/go v0.0.0-20260901203214-91f294b7a228 // indirect
	github.com/voxgig/struct/go v0.1.6 // indirect
	golang.org/x/sys v0.34.0 // indirect
)

// The generated SDKs are not published to any language registry yet, so the
// pin lives in spec/sources.aontu and `make sdk` puts the clone where this
// points. The same relative layout serves the TypeScript port's `file:`
// dependency, so one `make sdk` satisfies both.
replace github.com/voxgig-sdk/joplin-sdk/go => ../../voxgig-sdk/joplin-sdk/go

replace github.com/voxgig-sdk/notion-sdk/go => ../../voxgig-sdk/notion-sdk/go

replace github.com/voxgig-sdk/obsidian-sdk/go => ../../voxgig-sdk/obsidian-sdk/go

// station's Go module has no go/v0.0.1 tag yet (voxgig/station#27), so the
// version the SDKs require is mapped to the main revision its other ports are
// pinned at.
replace github.com/voxgig/station/go v0.0.1 => github.com/voxgig/station/go v0.0.0-20261015150408-9021c99c2253
