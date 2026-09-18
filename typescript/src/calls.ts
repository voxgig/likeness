
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
