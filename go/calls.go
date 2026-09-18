package likeness

// Call is one outbound request the command attempted.
type Call struct {
	Instance string
	Method   string
	Path     string
}

// Calls records them in order.
type Calls struct {
	list []Call
}

// Record notes one attempt. It is called BEFORE the request, so a call that
// fails still appears: the corpus asserts what was attempted, not what
// succeeded.
func (c *Calls) Record(instance, method, path string) {
	c.list = append(c.list, Call{instance, method, path})
}

// All returns a copy.
func (c *Calls) All() []Call {
	out := make([]Call, len(c.list))
	copy(out, c.list)
	return out
}

// Count is what `meta.calls` carries.
func (c *Calls) Count() int { return len(c.list) }
