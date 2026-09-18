module github.com/voxgig/likeness/go

go 1.21

require github.com/voxgig-sdk/joplin-sdk/go v0.0.0

// The generated SDKs are not published to any language registry yet, so the
// pin lives in spec/sources.aon and `make sdk` puts the clone where this
// points. The same relative layout serves the TypeScript port's `file:`
// dependency, so one `make sdk` satisfies both.
replace github.com/voxgig-sdk/joplin-sdk/go => ../../voxgig-sdk/joplin-sdk/go
