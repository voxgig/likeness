package likeness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCliCorpus(t *testing.T) {
	root := Root(t)
	all := corpusEntries(t, root, "cli")
	if 0 == len(all) {
		t.Fatal("spec/cli.json has no entries - did `make spec-build` run?")
	}

	seen := map[string]bool{}
	for _, e := range all {
		id := str(e, "id")
		if seen[id] {
			t.Errorf("duplicate corpus id: %s", id)
		}
		seen[id] = true

		t.Run(id, func(t *testing.T) {
			if f := Check(t, root, e); 0 < len(f) {
				t.Fatalf("%s:\n  %s", id, strings.Join(f, "\n  "))
			}
		})
	}
}

func TestNoUnreferencedExpectations(t *testing.T) {
	root := Root(t)
	used := map[string]bool{}
	for _, e := range corpusEntries(t, root, "cli") {
		out, _ := e["out"].(map[string]any)
		used[str(out, "stdout")] = true
	}

	base := filepath.Join(root, "spec", "expect")
	err := filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
		if nil != err {
			return err
		}
		if info.IsDir() || strings.HasPrefix(info.Name(), ".") {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if !used[rel] {
			t.Errorf("expectation file no entry refers to: %s", rel)
		}
		return nil
	})
	if nil != err {
		t.Fatal(err)
	}
}
