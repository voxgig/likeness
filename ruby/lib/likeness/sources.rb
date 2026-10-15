# frozen_string_literal: true

require 'fileutils'

require_relative 'adapters'
require_relative 'args'
require_relative 'caps'
require_relative 'config'
require_relative 'errors'
require_relative 'station'
require_relative 'vault'

module Likeness
  TAG_RE = /\A[a-z0-9-]+\z/
  # Scheme, host and port, and a path: no userinfo, query or fragment, which is
  # where a credential would be written.
  BASE_RE = %r{\Ahttps?://(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]{1,5})?(?:/[\x21\x22\x24-\x3e\x40-\x7e]*)?\z}
  # What String.prototype.trim takes off, which String#strip does not all take.
  JS_SPACE = '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  JS_TRIM = /\A#{JS_SPACE}+|#{JS_SPACE}+\z/

  LIST_REMEDY = 'run `likeness sources list` to see the configured connections'

  # Both configuration files as a `sources` write found them, and the
  # documents it changes.
  Config = Struct.new(:home, :station_path, :likeness_path, :station, :likeness, :doc, :accounts,
                      keyword_init: true)

  module_function

  # Station's name for an instance's secret when its block names none.
  def secret_name(ref)
    "#{ref.upcase.gsub(/[^A-Z0-9]+/, '_').gsub(/\A_+|_+\z/, '').downcase}.apikey"
  end

  # The ref `sources add` writes: the API alone, the API with --instance as its
  # tag, or --instance itself where it is a ref to the same API. A `$`-less
  # value is always a tag, as station reads one.
  def ref_for(source, instance = nil)
    raise bad("--source takes a source's name", 'run `likeness help sources add`') unless NAME_RE.match?(source)
    return source if instance.nil?

    at = instance.index('$')
    if !at.nil? && instance[0...at] != source
      raise bad('--instance names a connection to another API than --source does',
                "give the tag alone: `--source #{source} --instance <tag>` adds #{source}$<tag>")
    end
    tag = at.nil? ? instance : instance[(at + 1)..]
    unless TAG_RE.match?(tag)
      raise bad('--instance takes a tag of lowercase letters, digits and hyphens',
                "write `--instance work` to add #{source}$work")
    end

    "#{source}$#{tag}"
  end

  def ref_api(ref)
    at = ref.index('$')
    at.nil? ? ref : ref[0...at]
  end

  def named_secret?(block)
    block['secret'].is_a?(String) && !block['secret'].empty?
  end

  def secret_of(block, ref)
    named_secret?(block) ? block['secret'] : secret_name(ref)
  end

  def listed(names)
    1 == names.length ? names[0] : "#{names[0...-1].join(', ')} or #{names[-1]}"
  end

  def row_of(ref, block, account, active)
    row = { 'instance' => ref, 'source' => ref_api(ref), 'secret' => secret_of(block, ref) }
    row['base'] = block['base'] if block['base'].is_a?(String)
    row['account'] = account unless account.nil?
    row['active'] = false unless active
    row
  end

  # Every instance the active profile declares, the inactive ones marked, and
  # the account of each that likeness.json gives one.
  def sources_list(station, accounts)
    rows = station.instances.map { |i| row_of(i['name'], i['block'], accounts[i['name']], i['active']) }
    Answer.new(data: rows, count: rows.length, empty: rows.empty?)
  end

  # Both files, read fresh: a write keeps everything in them it does not change.
  def config_of(place)
    home = place.home || Dir.home
    station = place.config || joined(place.dir || joined(home, '.config', 'likeness'), 'station.json')
    likeness = joined(File.dirname(station), 'likeness.json')
    s = held(station, shown(station, home))
    l = held(likeness, shown(likeness, home))
    Config.new(home: home, station_path: station, likeness_path: likeness, station: s, likeness: l,
               doc: s.nil? ? doc_of({ 'station' => 1, 'profiles' => {} }) : parse_doc(s.text, shown(station, home)),
               accounts: l.nil? ? nil : parse_doc(l.text, shown(likeness, home)))
  rescue ConfigError => e
    raise LikenessError.new('invalid-project', e.message, CONFIG_REMEDY)
  end

  # Station opened on the document as it would be written. A refusal of
  # station's own is worded by the block, from its code and message.
  def station_of(config, place)
    open_station(with_chain(plain_of(config.doc), []), place.env)
  rescue StandardError => e
    code = e.respond_to?(:code) ? e.code : nil
    raise unless code.is_a?(String) && code.start_with?('station_')

    raise yield(code, e.message)
  end

  def as_read(config, place)
    station_of(config, place) do |_code, message|
      LikenessError.new('invalid-project', "#{shown(config.station_path, config.home)}: #{message}", CONFIG_REMEDY)
    end
  end

  # The object at path, or nil where a level is missing or not an object.
  def find_obj(obj, path)
    path.reduce(obj) do |at, key|
      found = at.nil? ? nil : member(at, key)
      found.is_a?(Doc::Obj) ? found : nil
    end
  end

  # The object at path, each missing level made; a level that is not an object is refused.
  def make_obj(obj, path, file)
    at = obj
    path.each_with_index do |key, i|
      found = member(at, key)
      if found.nil?
        found = Doc::Obj.new([])
        put(at, key, found)
      end
      unless found.is_a?(Doc::Obj)
        raise LikenessError.new('invalid-project', "#{file}'s #{path[0..i].join('.')} is not an object", CONFIG_REMEDY)
      end

      at = found
    end
    at
  end

  def sdk_of(config, profile)
    find_obj(config.doc, ['profiles', profile, 'sdk'])
  end

  def declares?(sdk, ref)
    !sdk.nil? && !member(sdk, ref).nil?
  end

  # Whether the active profile's own block declares ref, and whether the
  # default profile, which every other one inherits, declares it as well.
  def owned(config, profile, ref)
    mine = declares?(sdk_of(config, profile), ref)
    base = 'default' != profile && declares?(sdk_of(config, 'default'), ref)
    raise LikenessError.new('no-such-source', "no connection named \"#{ref}\"", LIST_REMEDY) if !mine && !base
    unless mine
      raise bad("connection \"#{ref}\" is the default profile's, which \"#{profile}\" inherits",
                'change it under the default profile, with VOXGIG_STATION_PROFILE unset')
    end
    return unless base

    raise bad("connection \"#{ref}\" would remain: the default profile declares it too, and \"#{profile}\" inherits it",
              "remove the default profile's first, with VOXGIG_STATION_PROFILE unset")
  end

  def block_of(station, ref)
    found = station.instances.find { |i| i['name'] == ref }
    found.nil? ? {} : found['block']
  end

  # likeness.json first, so station.json, which makes a connection, changes last.
  def commit(place, config, accounts)
    writes = []
    writes << Write.new(path: config.likeness_path, text: render_doc(accounts), was: config.likeness) unless accounts.nil?
    writes << Write.new(path: config.station_path, text: render_doc(config.doc), was: config.station)
    dir = shown(File.dirname(config.station_path), config.home)
    remedy = "check that #{dir} is writable and its disk has space"
    begin
      FileUtils.mkdir_p(File.dirname(config.station_path), mode: 0o700)
      write_all(writes, place.fs || FileOps)
    rescue WriteError => e
      left = e.restored ? 'nothing was changed' : 'a file already replaced could not be put back'
      raise LikenessError.new('invalid-project', "#{shown(e.path, config.home)} could not be written, and #{left}", remedy)
    rescue StandardError
      raise LikenessError.new('invalid-project', "#{dir} could not be written, and nothing was changed", remedy)
    end
  end

  def ask_of(place)
    tty = true == place.tty && !place.prompt.nil?
    confirm = lambda do |label|
      typed = tty ? place.prompt.call(label) : nil
      !typed.nil? && %w[y yes].include?(typed.gsub(JS_TRIM, '').tr('A-Z', 'a-z'))
    end
    presented = lambda do |base|
      raise "no probe for #{base}" if place.presented.nil?

      place.presented.call(base)
    end
    Ask.new(tty: tty, confirm: confirm, presented: presented)
  end

  def account_of(source, connect, given)
    account = connect['account']
    term = account['term']
    if account['discover']
      unless given.nil?
        raise bad("--account is for a source that cannot name its account, and #{source} names its own",
                  "drop --account; `sources add` asks #{source} for it")
      end

      return nil
    end
    if given.nil?
      why = account['why']
      raise bad("#{source}'s account cannot be discovered#{why.nil? ? '' : ": #{why}"}",
                "give --account with #{term}; every note's identity derives from it")
    end
    raise bad('--account is empty', "give --account with #{term}") if given.empty?

    given
  end

  def plain_block(_instance, given)
    given['base'].nil? ? {} : { 'base' => given['base'] }
  end

  # The account the source names, asked through a station on the configuration being written.
  def discover(place, adapter, config, ref, chain, watch)
    seed = place.fixture.nil? ? nil : place.fixture[ref]
    station = open_station(with_chain(plain_of(config.doc), seed.nil? ? chain : []), place.env)
    watch.call(station)
    api = ref_api(ref)
    detail = { 'source' => api, 'instance' => ref }
    conn = Connection.new(instance: ref, source: api, account: '')
    begin
      settings = adapter.respond_to?(:configure) ? adapter.configure(ref, block_of(station, ref)) : nil
      account = adapter.account(adapter.connect(station, conn, settings, seed))
    rescue LikenessError
      raise
    rescue StandardError => e
      code =
        case status_of(e)
        when 401, 403 then 'auth-failed'
        when 429 then 'rate-limited'
        else 'source-unavailable'
        end
      raise LikenessError.new(code, "#{api} did not name the account #{ref} reaches",
                              "run `likeness sources add` again once #{api} answers, or check its token", detail)
    end
    unless account.is_a?(String) && !account.empty?
      raise LikenessError.new('source-unavailable', "#{api} named no account for #{ref}",
                              'this is a bug in the source or its SDK', detail)
    end

    account
  end

  # What --source, --instance and the source's own flags decide, before
  # anything is read: the source, its connect row, its adapter and the ref.
  def addition_of(given)
    choose = "name one of #{listed(ADAPTERS.keys.select { |s| connect_of(s) }.sort)}"
    sources = given['source'] || []
    raise bad('`sources add` needs --source, the API to connect', choose) if sources.empty?
    if 1 < sources.length
      raise bad('--source was given more than once, and `sources add` adds one connection', 'give --source once')
    end

    source = sources[0]
    connect = connect_of(source)
    if connect.nil?
      raise LikenessError.new('no-such-source', 'likeness reaches no source by the name --source gives', choose)
    end

    adapter = ADAPTERS[source]
    if adapter.nil?
      raise LikenessError.new('unsupported-capability', "no adapter for source \"#{source}\" yet", choose,
                              { 'source' => source })
    end
    foreign = source_flags.select { |f| given.key?(f) && !connect['flag'].include?(f) }
    unless foreign.empty?
      raise bad("--#{foreign[0]} does not apply to a #{source} connection",
                'run `likeness help sources add` for the flags each source reads')
    end
    instances = given['instance'] || []
    if 1 < instances.length
      raise bad('--instance was given more than once, and `sources add` adds one connection',
                'give --instance once, with the tag')
    end

    [source, connect, adapter, ref_for(source, instances[0])]
  end

  # A connection added: refused before any prompt where the flags alone decide
  # it, its token stored in the vault before either file changes, and both
  # files written together or not at all.
  def sources_add(place, given, flags, watch = ->(_station) {})
    source, connect, adapter, ref = addition_of(given)
    base = given['base']
    if !base.nil? && !BASE_RE.match?(base)
      usual = connect['default']['base']
      raise bad('--base is not an http or https address without credentials, a query or a fragment',
                "give where the application answers#{usual.nil? ? ', as scheme, host and port' : ", such as #{usual}"}")
    end
    account = account_of(source, connect, given['account'])
    existing = given['secret']
    ask = ask_of(place)
    if existing.nil? && !ask.tty
      named = secret_name(ref)
      raise bad('the token is typed at a prompt, and stdin is not a terminal',
                "store it with `likeness secrets set #{named} -`, and name it with --secret #{named}")
    end

    config = config_of(place)
    profile = profile_of(place.env)
    current = as_read(config, place)
    if declares?(sdk_of(config, profile), ref)
      under = 'default' == profile ? '' : " under the profile \"#{profile}\""
      raise LikenessError.new('instance-exists', "a connection named \"#{ref}\" is already configured#{under}",
                              'choose another tag with --instance, or remove it first with ' \
                              "`likeness sources remove #{ref}`")
    end
    entry = vault_entry(plain_of(config.doc), profile: profile, home: config.home,
                                              dir: File.dirname(config.station_path), key: flags.vault_key)
    present(entry)

    chosen = connect['default'].dup
    (['base'] + connect['flag']).each { |f| chosen[f] = given[f] if given.key?(f) }
    made = adapter.respond_to?(:setup) ? adapter.setup(ref, chosen, ask) : plain_block(ref, chosen)

    found = placed(place, config, profile, ref, made, existing, current)
    begin
      adapter.configure(ref, found) if adapter.respond_to?(:configure)
    rescue LikenessError => e
      raise bad(e.message, 'run `likeness help sources add` for the flags each source reads')
    end

    stored(place, flags, entry, config, profile, ref, found, existing) do |phrase|
      chain = [{ 'kind' => 'minivault', 'file' => entry.file, 'vaultkey' => entry.key, 'passphrase' => phrase }]
      account.nil? ? discover(place, adapter, config, ref, chain, watch) : account
    end
  end

  # The block put under the active profile, as station reads it back: --secret
  # is written into it only where the ref's own secret name is another.
  def placed(place, config, profile, ref, made, existing, current)
    sdk = make_obj(config.doc, ['profiles', profile, 'sdk'], shown(config.station_path, config.home))
    # Station words a shared secret name differently in each of its ports.
    refused = lambda do |code, message|
      if 'station_secret_collision' == code
        want = existing || secret_name(ref)
        other = current.instances.find { |i| secret_of(i['block'], i['name']) == want }
        why = other.nil? ? "#{ref}'s secret name is another connection's as well" : "#{ref} would take its token from #{want}, as #{other['name']} does"
        bad(why, 'choose another tag with --instance, or name a secret of its own with --secret')
      else
        bad("station refuses the connection this would add: #{message}",
            'give --secret a name `likeness secrets list` shows')
      end
    end
    put(sdk, ref, doc_of(made))
    found = block_of(station_of(config, place, &refused), ref)
    return found if existing.nil? || existing == secret_of(found, ref)

    put(sdk, ref, doc_of(made.merge('secret' => existing)))
    block_of(station_of(config, place, &refused), ref)
  end

  # The token in the vault, then both files; a token stored here is taken out
  # again if what follows fails. The block names the account the files record.
  def stored(place, flags, entry, config, profile, ref, found, existing)
    secret = secret_of(found, ref)
    phrase = passphrase(place, flags, entry.key)
    vault, info = opened(entry, phrase)
    kept = nil
    begin
      if existing.nil?
        token_of(place, entry, info, vault, secret, ref)
        kept = secret
      elsif !vault.list.include?(secret)
        raise LikenessError.new('not-found', "the vault has no #{secret} that the key #{entry.key} can read",
                                "store it with `likeness secrets set #{secret}`, or name another with --secret")
      end

      id = yield(phrase)
      accounts = config.accounts || doc_of({ 'likeness' => 1, 'profiles' => {} })
      put(make_obj(accounts, ['profiles', profile, 'instances'], shown(config.likeness_path, config.home)), ref,
          doc_of({ 'account' => id }))
      commit(place, config, accounts)

      Answer.new(data: row_of(ref, found, id, true), count: 1,
                 text: "added #{ref}#{'default' == profile ? '' : " to the profile #{profile}"}, " \
                       "its token in the vault as #{secret}\n")
    rescue StandardError
      unless kept.nil?
        begin
          vault.remove(kept)
        rescue StandardError
          nil
        end
      end
      raise
    ensure
      vault.close
    end
  end

  # A new token, typed, stored under a name the vault does not hold yet.
  def token_of(place, entry, info, vault, secret, ref)
    unless info['master']
      raise LikenessError.new('vault-denied',
                              "only a master key stores a new secret, and the key #{entry.key} is restricted",
                              'run it as the master key, or store the token first and name it with --secret')
    end
    if vault.list.include?(secret)
      raise LikenessError.new('vault-exists',
                              "the vault already holds #{secret}, and `sources add` never overwrites a token",
                              "use it with --secret #{secret}, or drop it first with `likeness secrets remove #{secret}`")
    end
    token = place.prompt.call("token for #{ref}")
    raise bad('no token was given', 'run it again, and type the token') if token.nil? || token.empty?

    written(entry) { vault.set(secret, token) }
  end

  # A connection and its account removed together. The vault is the secrets group's.
  def sources_remove(place, ref)
    config = config_of(place)
    profile = profile_of(place.env)
    secret = secret_of(block_of(as_read(config, place), ref), ref)
    owned(config, profile, ref)
    drop(sdk_of(config, profile), ref)
    accounts = find_obj(config.accounts, ['profiles', profile, 'instances'])
    commit(place, config, !accounts.nil? && drop(accounts, ref) ? config.accounts : nil)
    Answer.new(data: { 'instance' => ref, 'secret' => secret }, count: 1,
               text: "removed #{ref}; the vault still holds #{secret}, which `likeness secrets` manages\n")
  end

  # A connection under a new ref, keeping its place in both files. A token found
  # by the ref's derived name is named in the block, since that name changes
  # with the ref.
  def sources_rename(place, from, to)
    if from == to
      raise bad("#{from} already has that ref", "give the new ref second: `likeness sources rename #{from} <new-ref>`")
    end

    api = ref_api(from)
    if ref_api(to) != api
      raise bad("a connection keeps its API, so #{from} cannot become #{to}",
                "rename it to #{api} or #{api}$<tag>; a connection to another API is added with `likeness sources add`")
    end
    config = config_of(place)
    profile = profile_of(place.env)
    station = as_read(config, place)
    owned(config, profile, from)
    if station.instances.any? { |i| i['name'] == to }
      raise LikenessError.new('instance-exists', "a connection named \"#{to}\" is already configured",
                              "choose another ref, or remove that one first with `likeness sources remove #{to}`")
    end
    before = block_of(station, from)
    sdk = sdk_of(config, profile)
    rekey(sdk, from, to)
    put(member(sdk, to), 'secret', doc_of(secret_name(from))) unless named_secret?(before)
    renamed = station_of(config, place) do |code, _message|
      bad("#{from} cannot become #{to}: station refuses the configuration that would leave, as #{code}",
          'choose another ref')
    end
    commit(place, config, move_account(config.accounts, profile, from, to) ? config.accounts : nil)
    secret = secret_of(block_of(renamed, to), to)
    Answer.new(data: { 'instance' => to, 'was' => from, 'secret' => secret }, count: 1,
               text: "renamed #{from} to #{to}; its token is still #{secret} in the vault\n")
  end

  # The account moved with the ref, replacing any the ref it moves to had;
  # whether likeness.json changed.
  def move_account(accounts, profile, from, to)
    instances = find_obj(accounts, ['profiles', profile, 'instances'])
    return false if instances.nil?

    moved = drop(instances, to)
    return moved if member(instances, from).nil?

    rekey(instances, from, to)
    true
  end
end
