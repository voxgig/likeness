# frozen_string_literal: true

require_relative 'spec'
require_relative 'errors'

module Likeness
  TABLE = Spec.load('commands').freeze
  HELP = Spec.load('help').freeze

  NAME_RE = /\A[a-z][a-z0-9-]*\z/
  INTEGER_RE = /\A(?:0|[1-9][0-9]*)\z/
  INSTANCE_RE = /\A[a-z][a-z0-9-]*(?:\$[a-z0-9-]+)?\z/
  SECRET_RE = /\A[a-z0-9_]+(?:\.[a-z0-9_]+)*\z/
  ENVVAR_RE = /\A[A-Za-z_][A-Za-z0-9_]*\z/

  # Where a secret is most likely to be typed by mistake, so never repeated.
  UNECHOED = %w[envvar stdin].freeze

  module_function

  def command_def(name)
    TABLE['command'][name]
  end

  # The actions of a group, `secrets` in `secrets init`, in code-point order.
  def actions_of(group)
    TABLE['command'].keys.select { |n| n.start_with?("#{group} ") }.map { |n| n[(group.length + 1)..] }.sort
  end

  # The words naming the command argv starts with, as far as they can be read.
  def command_words(argv)
    return argv[0, 2] if 1 < argv.length && command_def(argv[0]).nil? && command_def("#{argv[0]} #{argv[1]}")

    [argv[0] || '']
  end

  def help_text(name)
    HELP['text'][name]
  end

  def help_rows
    HELP['rows']
  end

  def bad(message, remedy)
    LikenessError.new('invalid-argument', message, remedy)
  end

  def described(spec)
    min = spec['min']
    max = spec['max']
    case spec['type']
    when 'integer'
      if min && max then "an integer from #{min} to #{max}"
      elsif min then "an integer of at least #{min}"
      elsif max then "an integer of at most #{max}"
      else 'an integer'
      end
    when 'name' then 'a name ([a-z][a-z0-9-]*)'
    when 'instance' then 'an instance ref (api or api$tag)'
    when 'path' then 'a path'
    when 'secret' then 'a secret name ([a-z0-9_] words joined by dots)'
    when 'envvar' then 'an environment variable name'
    else 'a string'
    end
  end

  # Decided on the digits, so a value too long for any host number is refused
  # rather than wrapped.
  def in_range?(raw, spec)
    min = spec['min']
    max = spec['max']
    return false if max && max.to_s.length < raw.length

    n = Integer(raw, 10)
    (min.nil? || min <= n) && (max.nil? || n <= max)
  end

  def checked(label, spec, raw, remedy, echo)
    ok =
      case spec['type']
      when 'integer' then INTEGER_RE.match?(raw) && in_range?(raw, spec)
      when 'name' then NAME_RE.match?(raw)
      when 'instance' then INSTANCE_RE.match?(raw)
      when 'path' then !raw.empty?
      when 'secret' then SECRET_RE.match?(raw)
      when 'envvar' then ENVVAR_RE.match?(raw)
      else true
      end
    unless ok
      shown = echo && !UNECHOED.include?(spec['type']) ? ", not \"#{raw}\"" : ''
      raise bad("#{label} takes #{described(spec)}#{shown}", remedy)
    end

    'integer' == spec['type'] ? Integer(raw, 10) : raw
  end

  def lookup(cmd, name)
    cmd['flag'][name] || TABLE['global'][name]
  end

  def flag_shaped?(arg)
    arg.start_with?('-') && '-' != arg
  end

  # The one table-driven parser over the declared command surface (SPEC 13.1).
  def parse_argv(argv)
    raise bad('no command given', 'try `likeness list`, or `likeness help` for the command list') if argv.empty?

    name = argv[0]
    if '--help' == name || '-h' == name
      name = 'help'
    elsif '--version' == name
      name = 'version'
    elsif flag_shaped?(name)
      raise bad("the command comes first, and #{name} is a flag", "put the command first: `likeness list #{name}`")
    end
    at = 1
    actions = command_def(name).nil? ? actions_of(name) : []
    unless actions.empty?
      action = argv[1]
      if action.nil? || action.start_with?('-')
        raise bad("`#{name}` needs an action: #{actions[0...-1].join(', ')} or #{actions[-1]}",
                  "run `likeness help #{name}` for what each does")
      end
      if command_def("#{name} #{action}").nil?
        raise bad("no such command: #{name} #{action}", "run `likeness help #{name}` for its actions")
      end

      name = "#{name} #{action}"
      at = 2
    end
    cmd = command_def(name)
    raise bad("no such command: #{name}", 'run `likeness help` for the command list') if cmd.nil?

    # A group's actions take secrets, so a refused argument is never repeated.
    echo = false != cmd['echo']
    remedy = "run `likeness help #{name}` for its arguments"
    flags = {}
    positional = []
    rest = argv[at..]
    i = -1

    while (i += 1) < rest.length
      arg = rest[i]
      if '--' == arg
        positional.concat(rest[(i + 1)..])
        break
      end
      unless arg.start_with?('--')
        # A command still being built reads its global flags and nothing else.
        if flag_shaped?(arg) && cmd['ready']
          unless echo
            raise bad('an argument begins with - and is not a flag; it is not repeated here, in case it is a secret',
                      'a positional that begins with - must follow --')
          end
          raise bad("#{arg} begins with - and is not a flag; a positional that begins with - must follow --",
                    "write `likeness #{name} -- #{arg}`")
        end
        positional << arg unless flag_shaped?(arg)
        next
      end

      eq = arg.index('=')
      given = eq.nil? ? arg[2..] : arg[2...eq]
      key = given
      spec = lookup(cmd, given)
      negated = false
      if spec.nil? && given.start_with?('no-')
        base = lookup(cmd, given[3..])
        if base && 'boolean' == base['type']
          spec = base
          key = given[3..]
          negated = true
        end
      end
      if spec.nil?
        next unless cmd['ready']

        raise bad("`#{name}` has no flag --#{given}", remedy) if echo

        raise bad("`#{name}` has no such flag; it is not repeated here, in case it is a secret", remedy)
      end

      if 'boolean' == spec['type']
        raise bad("--#{given} takes no value", "write --#{key}, or --no-#{key}") unless eq.nil?

        value = !negated
      else
        raw = nil
        if !eq.nil?
          raw = arg[(eq + 1)..]
        elsif i + 1 < rest.length && !flag_shaped?(rest[i + 1])
          raw = rest[i += 1]
        end
        if raw.nil?
          raise bad("--#{key} needs a value",
                    "write --#{key} #{spec['value']}, or --#{key}=#{spec['value']} for a value that begins with -")
        end
        value = checked("--#{key}", spec, raw, remedy, echo)
      end

      if true == spec['repeat']
        (flags[key] ||= []) << value
      else
        raise bad("--#{key} was given twice", 'give it once') if flags.key?(key)

        flags[key] = value
      end
    end

    return { 'command' => name, 'flags' => flags, 'args' => [] } unless cmd['ready']

    args = []
    at = 0
    cmd['arg'].each do |spec|
      taken = true == spec['repeat'] ? positional[at..] : positional[at, 1]
      raise bad("`#{name}` needs <#{spec['name']}>", remedy) if spec['required'] && taken.empty?

      taken.each do |raw|
        if 'stdin' == spec['type'] && '-' != raw
          raise bad("`#{name}` takes - there, never the value itself", 'pipe the value in, with - after the name')
        end
        args << checked("<#{spec['name']}>", spec, raw, remedy, echo)
      end
      at += taken.length
    end
    if at < positional.length
      raise bad("`#{name}` does not take the argument \"#{positional[at]}\"", remedy) if echo

      raise bad("`#{name}` takes no further argument; it is not repeated here, in case it is a secret", remedy)
    end

    { 'command' => name, 'flags' => flags, 'args' => args }
  end
end
