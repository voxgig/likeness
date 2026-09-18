/* The call recorder.
 *
 * `meta.calls` is in the envelope because a case study should make its own
 * traffic visible, and because the transcript corpus asserts on it: "the right
 * answer, in forty requests" is a bug, and this is where it is caught.
 *
 * Calls are recorded AT THE ADAPTER, as one record per SDK operation invoked,
 * rather than by tapping the SDK's transport. The transport seam is internal to
 * the generated SDK and differs per port, so tapping it would be five different
 * pieces of code doing one job; and for these four sources an operation is
 * exactly one request, because the generated paging feature records page
 * signals but does not follow them.
 */

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
