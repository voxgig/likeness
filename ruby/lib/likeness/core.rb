# frozen_string_literal: true

require 'voxgig_station'

require_relative 'adapter/joplin'
require_relative 'args'
require_relative 'calls'
require_relative 'envelope'
require_relative 'errors'
require_relative 'evaluate'
require_relative 'identity'
require_relative 'note'
require_relative 'selector'
require_relative 'vault'
require_relative 'version'

module Likeness
  # Every impure input, named. `station` is station.json in station's grammar,
  # `accounts` each instance's account from likeness.json beside it, `fixture`
  # the SDKs' offline seeds, absent in production. A path under `home` is shown
  # from `~`, a relative vault path is read from `dir`, and with `tty` what the
  # environment lacks may be asked for.
  Ctx = Struct.new(:argv, :env, :clock, :seed, :station, :accounts, :fixture, :path,
                   :home, :dir, :stdin, :tty, :prompt, keyword_init: true)

  Result = Struct.new(:exit, :stdout, :stderr, :calls, keyword_init: true)

  Connection = Struct.new(:instance, :source, :account, keyword_init: true)

  Flags = Struct.new(:json, :raw, :limit, :sort, :strict, :deterministic, :instance, :source,
                     :passphrase_env, :new_passphrase_env, :vault_key, :reveal, :write, keyword_init: true)

  ADAPTERS = { 'joplin' => Joplin }.freeze

  UNIVERSAL = %w[lid id title url created updated source instance].freeze

  # One station per run: every client is connected through it on first use,
  # and the calls a command made are the requests it observed.
  class Session
    attr_reader :conns, :calls

    def initialize(station, conns, fixture)
      @station = station
      @conns = conns
      @calls = Calls.new(station)
      @fixture = fixture || {}
      @clients = {}
    end

    def client(conn)
      @clients[conn.instance] ||= ADAPTERS.fetch(conn.source).connect(@station, conn.instance, @fixture[conn.instance])
    end
  end

  module_function

  def profile_of(env)
    profile = env&.fetch('VOXGIG_STATION_PROFILE', nil)
    profile.nil? || profile.empty? ? 'default' : profile
  end

  def open_station(config, env = nil)
    VoxgigStation::Station.new('config' => config, 'profile' => profile_of(env), 'proxy' => 'off', 'load' => false)
  end

  # station.json with its secret chain replaced, in every profile, by the one
  # likeness decided on.
  def with_chain(config, chain)
    return config unless config.is_a?(Hash)

    copy = Marshal.load(Marshal.dump(config))
    profiles = copy['profiles']
    (profiles.is_a?(Hash) ? profiles.values : []).each do |p|
      p['secrets'] = { 'providers' => chain } if p.is_a?(Hash)
    end
    copy
  end

  def entry_of(ctx, flags)
    home = ctx.home || Dir.home
    vault_entry(ctx.station, profile: profile_of(ctx.env), home: home,
                             dir: ctx.dir || File.join(home, '.config', 'likeness'), key: flags.vault_key)
  end

  # A live run with a connection to make opens its station on the vault.
  def open_session(ctx, flags)
    entry = entry_of(ctx, flags)
    station = open_station(with_chain(ctx.station, []), ctx.env)
    conns = connections_of(station, ctx.accounts || {})
    if ctx.fixture.nil? && !conns.empty?
      chain = vault_chain(ctx, entry, flags)
      begin
        station = open_station(with_chain(ctx.station, chain), ctx.env)
      rescue StandardError
        raise LikenessError.new('secret-backend-unavailable', 'station could not open the vault as its secret store',
                                'this port\'s station must read minivault stores; see "Secrets" in the README')
      end
    end
    Session.new(station, conns, ctx.fixture)
  end

  # Every declared active instance, in station's ref order, with the account
  # its notes' identity derives from. Identity is never derived from the ref.
  def connections_of(station, accounts)
    station.instances.select { |i| i['active'] }.map do |i|
      name = i['name']
      account = accounts[name]
      unless account.is_a?(String) && !account.empty?
        raise LikenessError.new('invalid-project', "instance \"#{name}\" has no account in likeness.json",
                                "add `\"#{name}\": { \"account\": \"<id>\" }` under `instances` in likeness.json")
      end
      Connection.new(instance: name, source: i['api'], account: account)
    end
  end

  def flags_of(parsed)
    f = parsed['flags']
    Flags.new(json: true == f['json'], raw: true == f['raw'], strict: true == f['strict'],
              deterministic: true == f['deterministic'], limit: f['limit'], sort: f['sort'],
              instance: f['instance'] || [], source: f['source'] || [],
              passphrase_env: f['passphrase-env'], new_passphrase_env: f['new-passphrase-env'],
              vault_key: f['vault-key'], reveal: true == f['reveal'], write: true == f['write'])
  end

  # Split as JavaScript splits: an empty name is one empty word.
  def words(name)
    name.empty? ? [''] : name.split(/ /, -1)
  end

  def envelope(cmd, code, data, meta = {}, error = nil)
    env = {
      'ok' => error.nil?,
      'code' => code,
      'cmd' => cmd.flat_map { |c| words(c) },
      'data' => data,
      'meta' => {
        'count' => meta.fetch(:count, 0),
        'truncated' => meta.fetch(:truncated, false),
        'sources' => meta.fetch(:sources, []),
        'incomplete' => meta.fetch(:incomplete, []),
        'calls' => meta.fetch(:calls, 0),
        'elapsed_ms' => 0,
      },
      'port' => PORT,
      'version' => VERSION,
    }
    env['error'] = error unless error.nil?
    env
  end

  def fails(env, message, remedy)
    env['error'] = { 'message' => message, 'remedy' => remedy }
    env['ok'] = false
    env
  end

  def quoted(names)
    names.sort.map { |s| "\"#{s}\"" }.join(', ')
  end

  def selected(all, flags)
    unknown = flags.instance.reject { |i| all.any? { |c| c.instance == i } }
    unless unknown.empty?
      raise LikenessError.new('no-such-source', "no connection named #{quoted(unknown)}",
                              'run `likeness doctor` to see the configured connections')
    end
    unknown = flags.source.reject { |s| all.any? { |c| c.source == s } }
    unless unknown.empty?
      raise LikenessError.new('no-such-source', "no connection uses source #{quoted(unknown)}",
                              'run `likeness doctor` to see the configured connections')
    end

    all.select do |c|
      (flags.instance.empty? || flags.instance.include?(c.instance)) &&
        (flags.source.empty? || flags.source.include?(c.source))
    end
  end

  def no_adapter(conn, remedy)
    LikenessError.new('unsupported-capability',
                      "no adapter for source \"#{conn.source}\" (connection \"#{conn.instance}\")", remedy)
  end

  # Fetch from every selected connection, carrying a failure the whole length
  # of the pipeline: a silently dropped source gives a smaller, wrong answer.
  def gather(session, conns, with_raw, strict)
    notes = []
    ok = []
    failed = []
    short = []
    conns.each do |conn|
      adapter = ADAPTERS[conn.source]
      # Refused BEFORE the network, not sent through whichever adapter is loaded.
      raise no_adapter(conn, 'drop that connection, or narrow to one that is supported with --source') if adapter.nil?

      client = session.client(conn)
      begin
        got = adapter.list_notes(client, conn, with_raw)
        notes.concat(got[:notes])
        ok << conn.instance
        short << conn.instance if got[:more]
      rescue StandardError => e
        raise if e.is_a?(LikenessError) && 'unsupported-capability' == e.code

        failed << conn.instance
        # `--strict` HALTS: `fanout-halted` means the fan-out stopped.
        break if strict
      end
    end
    { notes: notes, ok: ok.sort, failed: failed.sort, short: short.sort }
  end

  def supplies(conn)
    UNIVERSAL + ({ 'joplin' => Joplin::SUPPLIES }[conn.source] || [])
  end

  def unanswerable(conns, fields)
    return [] if conns.empty?

    sets = conns.map { |c| supplies(c) }
    fields.reject { |f| sets.all? { |s| s.include?(f) } }.sort
  end

  def cmd_list(ctx, flags, rest, session)
    conns = selected(session.conns, flags)
    clock_ms = parse_rfc3339(ctx.clock)

    filter = nil
    selector = rest.join(' ')
    unless selector.empty?
      filter = parse_selector(selector)
      unsupported = unanswerable(conns, fields_of(filter))
      unless unsupported.empty?
        raise LikenessError.new('unsupported-capability',
                                "no source can answer a question about #{unsupported.join(', ')}",
                                'drop that term, or narrow to a source that supplies it with --source')
      end
    end

    got = gather(session, conns, flags.raw, flags.strict)
    notes = got[:notes]
    notes = notes.select { |n| evaluate(filter, n, clock_ms) } unless filter.nil?
    notes = sort_notes(notes, flags.sort)

    truncated = false
    if !flags.limit.nil? && flags.limit < notes.length
      notes = notes.first(flags.limit)
      truncated = true
    end
    # A source that filled its page may have more, and is NAMED in
    # `meta.incomplete`: a silently short list makes every result wrong.
    truncated = true unless got[:short].empty?
    incomplete = (got[:failed] + got[:short]).sort

    code =
      if !got[:failed].empty? && flags.strict then 'fanout-halted'
      elsif !got[:failed].empty? && got[:ok].empty? then 'source-unavailable'
      elsif !incomplete.empty? then 'partial'
      # The answer "none" is not an error: `ok` stays true, the exit is 1.
      elsif notes.empty? then 'no-match'
      else 'ok'
      end

    env = envelope(['list'], code, notes, count: notes.length, truncated: truncated, sources: got[:ok],
                                          incomplete: incomplete, calls: session.calls.count)
    case code
    when 'fanout-halted'
      fails(env, "#{got[:failed].join(', ')} did not answer and --strict was given",
            'drop --strict to accept a partial answer, or fix the named connection')
    when 'source-unavailable'
      # null, not []: [] means the sources held nothing, null that none could be asked.
      env['data'] = nil
      fails(env, "no source answered: #{got[:failed].join(', ')}",
            'run `likeness doctor` to see which connection is failing and why')
    else env
    end
  end

  def cmd_get(flags, refs, session)
    notes = refs.map do |ref|
      at = ref.index(':')
      if at.nil? || at < 1
        raise LikenessError.new('invalid-ref', "not a ref: #{ref}", 'a ref is <instance>:<id>, a lid, #n or @alias')
      end

      instance = ref[0...at]
      id = ref[(at + 1)..]
      if id.empty?
        raise LikenessError.new('invalid-ref', "not a ref: #{ref} (no id after the colon)",
                                'a ref is <instance>:<id>, a lid, #n or @alias')
      end
      # A dot segment substituted into a route would name another resource.
      if '.' == id || '..' == id
        raise LikenessError.new('invalid-ref', "not a ref: #{ref} (an id is never . or ..)",
                                'a ref is <instance>:<id>, a lid, #n or @alias')
      end
      conn = session.conns.find { |c| c.instance == instance }
      if conn.nil?
        raise LikenessError.new('no-such-source', "no connection named \"#{instance}\"",
                                'run `likeness doctor` to see the configured connections')
      end
      adapter = ADAPTERS[conn.source]
      raise no_adapter(conn, 'this source arrives in a later stage') if adapter.nil?

      note = adapter.load_note(session.client(conn), conn, id, flags.raw)
      if note.nil?
        raise LikenessError.new('not-found', "#{ref} does not exist",
                                'check the ref, or run `likeness list` to see what is there')
      end
      note
    end
    envelope(['get'], 'ok', notes, count: notes.length, sources: notes.map { |n| n['instance'] }.uniq.sort,
                                   calls: session.calls.count)
  end

  def cmd_doctor(flags, session)
    conns = selected(session.conns, flags)
    failures = []
    rows = conns.map do |conn|
      adapter = ADAPTERS[conn.source]
      if adapter.nil?
        # REPORTED rather than refused: naming the source is the diagnosis.
        failures << 'unsupported-capability'
        next { 'instance' => conn.instance, 'source' => conn.source, 'check' => 'FAIL',
               'detail' => 'no adapter for this source yet', 'code' => 'unsupported-capability' }
      end
      r = adapter.check(session.client(conn))
      row = { 'instance' => conn.instance, 'source' => conn.source, 'check' => r[:ok] ? 'ok' : 'FAIL',
              'detail' => r[:detail] }
      unless r[:ok]
        row['code'] = r[:code]
        failures << r[:code]
      end
      row
    end
    # The worst row wins: highest exit status, then code name to break a tie.
    worst = failures.uniq.min_by { |c| [-exit_for(c), c] }
    env = envelope(['doctor'], worst || 'ok', rows, count: rows.length, sources: conns.map(&:instance).sort,
                                                    calls: session.calls.count)
    return env if failures.empty?

    fails(env, "#{failures.length} #{1 == failures.length ? 'connection needs' : 'connections need'} attention",
          'start the application, check the token, and re-run `likeness doctor`')
  end

  def cmd_version
    envelope(['version'], 'ok', { 'port' => PORT, 'version' => VERSION }, count: 1)
  end

  # Injected rather than probed, so `which` is a corpus entry like the rest;
  # the argv shell probes. None given is the empty answer, not a placeholder.
  def cmd_which(ctx)
    rows = ctx.path || []
    envelope(['which'], rows.empty? ? 'no-match' : 'ok', rows, count: rows.length)
  end

  # The text is rendered from the command table at build time; JSON gets the rows.
  def cmd_help(args)
    name = args.join(' ')
    text = help_text(name)
    raise LikenessError.new('invalid-argument', "no such command: #{name}", 'run `likeness help` for the command list') if text.nil?

    rows = help_rows.select { |r| name.empty? || r['command'] == name || r['command'].start_with?("#{name} ") }
    [envelope(['help'], 'ok', rows, count: rows.length), text]
  end

  def cmd_secrets(ctx, name, flags, args)
    got = secrets(name.delete_prefix('secrets '), args, entry_of(ctx, flags), ctx, flags)
    [envelope([name], got.empty ? 'no-match' : 'ok', got.data, count: got.count), got.text]
  end

  def run(ctx)
    started = clock_now
    argv = ctx.argv

    # The grammar decides first: a refused argument runs nothing at all.
    begin
      parsed = parse_argv(argv)
    rescue StandardError => e
      return result(error_envelope(command_words(argv).join(' '), e, Calls.new), argv.include?('--json'),
                    argv.include?('--deterministic'), nil, Calls.new, started)
    end

    name = parsed['command']
    flags = flags_of(parsed)
    calls = Calls.new
    text = nil
    env =
      begin
        cmd = command_def(name)
        unless cmd['ready']
          raise LikenessError.new('unsupported-capability', "`#{name}` is not implemented yet - #{cmd['short']}",
                                  'it arrives in a later stage; run `likeness help` for what works now')
        end
        case name
        when 'help'
          help, text = cmd_help(parsed['args'])
          help
        when 'version' then cmd_version
        when 'which' then cmd_which(ctx)
        when /\Asecrets /
          answer, text = cmd_secrets(ctx, name, flags, parsed['args'])
          answer
        else
          session = open_session(ctx, flags)
          calls = session.calls
          case name
          when 'list' then cmd_list(ctx, flags, parsed['args'], session)
          when 'get' then cmd_get(flags, parsed['args'], session)
          when 'doctor' then cmd_doctor(flags, session)
          else raise "declared ready and not dispatched: #{name}"
          end
        end
      rescue StandardError => e
        error_envelope(name, e, calls)
      end
    result(env, flags.json, flags.deterministic, text, calls, started)
  end

  def clock_now
    Process.clock_gettime(Process::CLOCK_MONOTONIC, :millisecond)
  end

  # Measured once, around the whole command, and zeroed under --deterministic
  # so the declared exception cannot defeat the byte diff.
  def result(env, json, deterministic, text, calls, started)
    env['meta']['elapsed_ms'] = deterministic ? 0 : clock_now - started
    Result.new(exit: exit_for(env['code']), stdout: json ? serialise(env) : (text || human(env)),
               stderr: json ? '' : narrate(env), calls: calls.all)
  end

  def error_envelope(name, err, calls)
    meta = { calls: calls.count }
    if err.is_a?(SelectorError)
      return envelope([name], 'invalid-selector', nil, meta,
                      { 'message' => "#{err.message} at byte #{err.offset}",
                        'remedy' => 'check the selector grammar with `likeness describe`' })
    end
    if err.is_a?(LikenessError)
      return envelope([name], err.code, nil, meta,
                      { 'message' => err.message, 'remedy' => err.remedy }.merge(err.detail))
    end
    if err.respond_to?(:code) && 'station_config_invalid' == err.code
      return envelope([name], 'invalid-project', nil, meta,
                      { 'message' => err.message,
                        'remedy' => 'fix station.json; station validates it against its own shape' })
    end
    code =
      case status_of(err)
      when 401, 403 then 'auth-failed'
      when 429 then 'rate-limited'
      else 'source-unavailable'
      end
    # The source's own words differ per port and embed the URL that was tried.
    envelope([name], code, nil, meta,
             { 'message' => 'the source did not complete the request',
               'remedy' => 'run `likeness doctor` to see which connection is failing and why' })
  end

  # Rendered by the envelope writer, never a host JSON writer, whose key order
  # would put the parity gap on stdout.
  def human(env)
    data = env['data']
    return '' if data.nil? || (data.is_a?(Array) && data.empty?)

    if data.is_a?(Array) && data[0].is_a?(Hash) && data[0].key?('lid')
      lines = data.each_with_index.map do |n, i|
        "#{(i + 1).to_s.rjust(3)}  #{n['instance'].ljust(8)}  #{n['title']}"
      end
      return "#{lines.join("\n")}\n"
    end
    return "#{data.map { |r| render(r) }.join("\n")}\n" if data.is_a?(Array)

    "#{render(data)}\n"
  end

  def narrate(env)
    out = []
    incomplete = env['meta']['incomplete']
    out << "#{incomplete.join(', ')} unavailable - results are incomplete" unless incomplete.empty?
    if env.key?('error')
      out << "error: #{env['code']}"
      out << "  #{env['error']['message']}"
      out << "  remedy  #{env['error']['remedy']}"
    end
    out.empty? ? '' : "#{out.join("\n")}\n"
  end
end
