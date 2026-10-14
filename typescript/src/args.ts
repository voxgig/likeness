
import commandsDoc from './spec/commands.json' with { type: 'json' }
import helpDoc from './spec/help.json' with { type: 'json' }
import { LikenessError } from './errors.js'

export type FlagDef = {
  type: string, short: string, value?: string, repeat?: boolean, min?: number, max?: number,
}
export type ArgDef = { name: string, type: string, required: boolean, repeat?: boolean, short: string }
export type CommandDef = {
  short: string, ready: boolean, writes: boolean, echo?: boolean, arg: ArgDef[],
  flag: Record<string, FlagDef>, exits: string[],
}

const TABLE = commandsDoc as unknown as {
  global: Record<string, FlagDef>, command: Record<string, CommandDef>
}
const HELP = helpDoc as unknown as {
  text: Record<string, string>, rows: { command: string, takes: string, does: string }[]
}

export function commandDef (name: string): CommandDef | undefined {
  return Object.hasOwn(TABLE.command, name) ? TABLE.command[name] : undefined
}

// The actions of a group, `secrets` in `secrets init`, in code-point order.
export function actionsOf (group: string): string[] {
  return Object.keys(TABLE.command).filter(n => n.startsWith(group + ' '))
    .map(n => n.slice(group.length + 1)).sort()
}

// The words naming the command argv starts with, as far as they can be read.
export function commandWords (argv: string[]): string[] {
  if (1 < argv.length && undefined === commandDef(argv[0]) &&
      undefined !== commandDef(argv[0] + ' ' + argv[1])) return [argv[0], argv[1]]
  return [argv[0] ?? '']
}

export function helpText (name: string): string | undefined {
  return Object.hasOwn(HELP.text, name) ? HELP.text[name] : undefined
}

export function helpRows (): { command: string, takes: string, does: string }[] {
  return HELP.rows
}

export type Parsed = { command: string, flags: Record<string, unknown>, args: string[] }

const NAME_RE = /^[a-z][a-z0-9-]*$/
const INTEGER_RE = /^(0|[1-9][0-9]*)$/
const INSTANCE_RE = /^[a-z][a-z0-9-]*(\$[a-z0-9-]+)?$/
const SECRET_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/
const ENVVAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Where a secret is most likely to be typed by mistake, so never repeated.
const UNECHOED = ['envvar', 'stdin']

function bad (message: string, remedy: string): LikenessError {
  return new LikenessError('invalid-argument', message, remedy)
}

function described (def: FlagDef | ArgDef): string {
  if ('integer' === def.type) {
    const f = def as FlagDef
    if (undefined !== f.min && undefined !== f.max) return 'an integer from ' + f.min + ' to ' + f.max
    if (undefined !== f.min) return 'an integer of at least ' + f.min
    if (undefined !== f.max) return 'an integer of at most ' + f.max
    return 'an integer'
  }
  if ('name' === def.type) return 'a name ([a-z][a-z0-9-]*)'
  if ('instance' === def.type) return 'an instance ref (api or api$tag)'
  if ('path' === def.type) return 'a path'
  if ('secret' === def.type) return 'a secret name ([a-z0-9_] words joined by dots)'
  if ('envvar' === def.type) return 'an environment variable name'
  return 'a string'
}

// Within range is decided on the digits, so a value too long for the host's
// number type is refused rather than wrapped.
function inRange (raw: string, def: FlagDef): boolean {
  if (undefined !== def.max && raw.length > String(def.max).length) return false
  const n = Number(raw)
  return (undefined === def.min || def.min <= n) && (undefined === def.max || n <= def.max)
}

function checked (label: string, def: FlagDef | ArgDef, raw: string, remedy: string, echo: boolean): unknown {
  const ok =
    'integer' === def.type ? INTEGER_RE.test(raw) && inRange(raw, def as FlagDef) :
    'name' === def.type ? NAME_RE.test(raw) :
    'instance' === def.type ? INSTANCE_RE.test(raw) :
    'path' === def.type ? '' !== raw :
    'secret' === def.type ? SECRET_RE.test(raw) :
    'envvar' === def.type ? ENVVAR_RE.test(raw) :
    true
  if (!ok) {
    const shown = echo && !UNECHOED.includes(def.type) ? ', not "' + raw + '"' : ''
    throw bad(label + ' takes ' + described(def) + shown, remedy)
  }
  return 'integer' === def.type ? Number(raw) : raw
}

// Own properties only: `--constructor` must not find Object.prototype's.
function lookup (cmd: CommandDef, name: string): FlagDef | undefined {
  if (Object.hasOwn(cmd.flag, name)) return cmd.flag[name]
  if (Object.hasOwn(TABLE.global, name)) return TABLE.global[name]
  return undefined
}

function isFlagShaped (a: string): boolean {
  return a.startsWith('-') && '-' !== a
}

export function parseArgv (argv: string[]): Parsed {
  if (0 === argv.length) {
    throw bad('no command given', 'try `likeness list`, or `likeness help` for the command list')
  }
  let name = argv[0]
  if ('--help' === name || '-h' === name) name = 'help'
  else if ('--version' === name) name = 'version'
  else if (isFlagShaped(name)) {
    throw bad('the command comes first, and ' + name + ' is a flag',
      'put the command first: `likeness list ' + name + '`')
  }
  let at = 1
  const actions = undefined === commandDef(name) ? actionsOf(name) : []
  if (0 < actions.length) {
    const action = argv[1]
    if (undefined === action || action.startsWith('-')) {
      throw bad('`' + name + '` needs an action: ' + actions.slice(0, -1).join(', ') +
        ' or ' + actions[actions.length - 1], 'run `likeness help ' + name + '` for what each does')
    }
    if (undefined === commandDef(name + ' ' + action)) {
      throw bad('no such command: ' + name + ' ' + action, 'run `likeness help ' + name + '` for its actions')
    }
    name = name + ' ' + action
    at = 2
  }
  const cmd = commandDef(name)
  if (undefined === cmd) throw bad('no such command: ' + name, 'run `likeness help` for the command list')

  const echo = false !== cmd.echo
  const remedy = 'run `likeness help ' + name + '` for its arguments'
  const flags: Record<string, unknown> = {}
  const positional: string[] = []
  const rest = argv.slice(at)

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if ('--' === a) {
      positional.push(...rest.slice(i + 1))
      break
    }
    if (!a.startsWith('--')) {
      // A command still being built reads its global flags and nothing else.
      if (isFlagShaped(a) && cmd.ready) {
        if (!echo) {
          throw bad('an argument begins with - and is not a flag; it is not repeated here, in case it is a secret',
            'a positional that begins with - must follow --')
        }
        throw bad(a + ' begins with - and is not a flag; a positional that begins with - must follow --',
          'write `likeness ' + name + ' -- ' + a + '`')
      }
      if (!isFlagShaped(a)) positional.push(a)
      continue
    }

    const eq = a.indexOf('=')
    const given = -1 === eq ? a.slice(2) : a.slice(2, eq)
    let key = given
    let def = lookup(cmd, given)
    let negated = false
    if (undefined === def && given.startsWith('no-')) {
      const base = lookup(cmd, given.slice(3))
      if ('boolean' === base?.type) {
        def = base
        key = given.slice(3)
        negated = true
      }
    }
    if (undefined === def) {
      if (!cmd.ready) continue
      throw bad(echo
        ? '`' + name + '` has no flag --' + given
        : '`' + name + '` has no such flag; it is not repeated here, in case it is a secret', remedy)
    }

    let value: unknown
    if ('boolean' === def.type) {
      if (-1 !== eq) throw bad('--' + given + ' takes no value', 'write --' + key + ', or --no-' + key)
      value = !negated
    }
    else {
      let raw: string | undefined
      if (-1 !== eq) raw = a.slice(eq + 1)
      else if (i + 1 < rest.length && !isFlagShaped(rest[i + 1])) raw = rest[++i]
      if (undefined === raw) {
        throw bad('--' + key + ' needs a value',
          'write --' + key + ' ' + def.value + ', or --' + key + '=' + def.value +
          ' for a value that begins with -')
      }
      value = checked('--' + key, def, raw, remedy, echo)
    }

    if (true === def.repeat) {
      const list = (flags[key] ?? []) as unknown[]
      list.push(value)
      flags[key] = list
    }
    else {
      if (Object.hasOwn(flags, key)) throw bad('--' + key + ' was given twice', 'give it once')
      flags[key] = value
    }
  }

  if (!cmd.ready) return { command: name, flags, args: [] }

  const args: string[] = []
  let p = 0
  for (const def of cmd.arg) {
    const taken = true === def.repeat ? positional.slice(p) : positional.slice(p, p + 1)
    if (def.required && 0 === taken.length) throw bad('`' + name + '` needs <' + def.name + '>', remedy)
    for (const raw of taken) {
      if ('stdin' === def.type && '-' !== raw) {
        throw bad('`' + name + '` takes - there, never the value itself',
          'pipe the value in, with - after the name')
      }
      args.push(checked('<' + def.name + '>', def, raw, remedy, echo) as string)
    }
    p += taken.length
  }
  if (p < positional.length) {
    throw bad(echo
      ? '`' + name + '` does not take the argument "' + positional[p] + '"'
      : '`' + name + '` takes no further argument; it is not repeated here, in case it is a secret', remedy)
  }
  return { command: name, flags, args }
}
