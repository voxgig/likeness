/* The call recorder.
 *
 * `meta.calls` is in the envelope because a case study should make its own
 * traffic visible, and because the transcript corpus asserts on it: "the right
 * answer, in forty requests" is a bug, and this is where it is caught.
 *
 * Calls are recorded AT THE ADAPTER, as one record per SDK operation invoked,
 * rather than by tapping the SDK's transport. Two reasons. The transport seam
 * is internal to the generated SDK and differs per port, so tapping it would be
 * five different pieces of code doing one job. And for these four sources an
 * operation is exactly one request: the generated paging feature records page
 * signals but does not follow them, so `list()` is one call, which is verified
 * rather than assumed.
 *
 * Where that stops being true - a source whose SDK auto-pages - the adapter
 * records what it actually caused, and the corpus entry that notices is the
 * point of having the count at all.
 */

export type Call = {
  instance: string
  method: string
  path: string
}

export class Calls {
  private list: Call[] = []

  record (instance: string, method: string, path: string): void {
    this.list.push({ instance, method, path })
  }

  all (): Call[] { return this.list.slice() }
  count (): number { return this.list.length }
}
