package likeness

import (
	"sync"

	"github.com/voxgig/station/go/station"
)

// Call is one outbound request the command attempted.
type Call struct {
	Instance string
	Method   string
	Path     string
}

// Calls is the requests a run made, as station observed them at the
// transport, one per attempt. Tapped, because the event ring drops its oldest.
type Calls struct {
	mu   sync.Mutex
	list []Call
}

func NewCalls(st *station.Station) *Calls {
	c := &Calls{}
	if nil != st {
		st.Tap(func(e station.Event) {
			if "http" == e.Kind && nil != e.HTTP {
				c.mu.Lock()
				c.list = append(c.list, Call{e.Plugin, e.HTTP.Method, e.HTTP.Path})
				c.mu.Unlock()
			}
		})
	}
	return c
}

// All returns a copy.
func (c *Calls) All() []Call {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Call, len(c.list))
	copy(out, c.list)
	return out
}

// Count is what `meta.calls` carries.
func (c *Calls) Count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.list)
}
