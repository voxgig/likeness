# frozen_string_literal: true

require 'fileutils'
require 'voxgig_sekreto/plugins/minivault'

require_relative 'envelope'
require_relative 'errors'

module Likeness
  DEFAULT_FILE = 'likeness.skmv'
  PASSPHRASE_ENV = 'LIKENESS_PASSPHRASE'
  NEW_PASSPHRASE_ENV = 'LIKENESS_NEW_PASSPHRASE'

  ENTRY_KEYS = %w[file kind vaultkey].freeze
  KEY_RE = /\A[a-z][a-z0-9-]*\z/
  VAULT_REMEDY = 'name the vault alone: "providers": [{ "kind": "minivault", "file": "likeness.skmv" }]'
  NOT_A_TERMINAL = 'is not set, and stdin is not a terminal to ask on'

  VaultEntry = Struct.new(:file, :key, :shown, keyword_init: true)

  Answer = Struct.new(:data, :count, :text, :empty, keyword_init: true)

  module_function

  def refused(message, remedy = VAULT_REMEDY)
    LikenessError.new('invalid-project', message, remedy)
  end

  # Node's path.resolve: File.expand_path would also expand a leading `~`.
  def resolved(path, base = nil)
    plain = ->(p) { p.start_with?('/') ? p : "./#{p}" }
    return File.expand_path(plain.call(path)) if base.nil?

    File.expand_path(plain.call(path), File.expand_path(plain.call(base)))
  end

  def shown(path, home)
    h = resolved(home)
    return '~' if path == h

    path.start_with?("#{h}/") ? "~/#{path[(h.length + 1)..]}" : path
  end

  def located(file, home, dir)
    return resolved(file[2..], home) if file.start_with?('~/')

    file.start_with?('/') ? resolved(file) : resolved(file, dir)
  end

  # A JSON null is a chain; a missing key is none.
  def chain_of(profile)
    secrets = profile.is_a?(Hash) ? profile['secrets'] : nil
    secrets.is_a?(Hash) && secrets.key?('providers') ? [secrets['providers']] : []
  end

  def checked_entry(providers)
    unless providers.is_a?(Array) && 1 == providers.length
      raise refused("station.json's secrets.providers must name one store, the vault")
    end

    only = providers[0]
    kind = only.is_a?(Hash) ? only['kind'] : only
    if !only.is_a?(Hash) || 'minivault' != kind
      raise refused('likeness reads secrets from its vault alone, and station.json names the store ' \
                    "\"#{text_of(kind)}\"")
    end
    if only.key?('passphrase')
      raise refused("station.json holds the vault's passphrase, and a passphrase is never written to a file",
                    "remove it, and set #{PASSPHRASE_ENV} or name a variable with --passphrase-env")
    end
    extra = only.keys.reject { |k| ENTRY_KEYS.include?(k) }.min { |a, b| compare_code_points(a, b) }
    if extra
      raise refused("the vault entry in station.json has no key \"#{extra}\"",
                    'the vault entry takes kind, file and vaultkey')
    end
    if only.key?('file') && !(only['file'].is_a?(String) && !only['file'].empty?)
      raise refused("the vault entry's file is not a path", 'name the file: "file": "likeness.skmv"')
    end
    if only.key?('vaultkey') && !(only['vaultkey'].is_a?(String) && KEY_RE.match?(only['vaultkey']))
      raise refused("the vault entry's vaultkey is not a key name", 'a key name is [a-z][a-z0-9-]*')
    end

    only
  end

  # The one secret store likeness allows: a minivault, chosen the way station
  # chooses its profile's chain, with no passphrase written beside it.
  def vault_entry(station, profile:, home:, dir:, key: nil)
    profiles = station.is_a?(Hash) && station['profiles'].is_a?(Hash) ? station['profiles'] : {}
    named = 'default' == profile ? [] : chain_of(profiles[profile])
    named = chain_of(profiles['default']) if named.empty? || named[0].nil?
    entry = named.empty? ? {} : checked_entry(named[0])

    file = located(entry['file'].is_a?(String) ? entry['file'] : DEFAULT_FILE, home, dir)
    key ||= entry['vaultkey'].is_a?(String) ? entry['vaultkey'] : 'master'
    VaultEntry.new(file: file, key: key, shown: shown(file, home))
  end

  def present(entry)
    return if File.exist?(entry.file)

    raise LikenessError.new('secret-backend-unavailable', "no vault at #{entry.shown}",
                            'run `likeness secrets init` to create it, or point station.json at the vault')
  end

  def asked(ask, label)
    true == ask.tty && ask.prompt ? [ask.prompt.call(label)] : nil
  end

  # The passphrase that opens the vault: from the environment, else typed.
  def passphrase(ask, flags, key)
    value = (ask.env || {})[flags.passphrase_env || PASSPHRASE_ENV]
    return value unless value.nil? || value.empty?

    typed = asked(ask, "passphrase for #{key}")
    unless typed.nil?
      return typed[0] unless typed[0].nil? || typed[0].empty?

      raise LikenessError.new('vault-locked', 'no passphrase was given', 'run it again, and type the passphrase')
    end
    # The variable a flag named is not repeated: a passphrase given there by
    # mistake would otherwise be printed.
    if flags.passphrase_env.nil?
      raise LikenessError.new('vault-locked', "no passphrase: #{PASSPHRASE_ENV} #{NOT_A_TERMINAL}",
                              "set #{PASSPHRASE_ENV}, or name another variable with --passphrase-env")
    end
    raise LikenessError.new('vault-locked', "no passphrase: the variable --passphrase-env names #{NOT_A_TERMINAL}",
                            'set that variable, or run on a terminal to be asked')
  end

  # A passphrase for a key being made, typed twice when it is typed at all.
  def new_passphrase(ask, flagged, fallback, flag, label)
    value = (ask.env || {})[flagged || fallback]
    return value unless value.nil? || value.empty?

    typed = asked(ask, label)
    unless typed.nil?
      first = typed[0]
      if first.nil? || first.empty?
        raise LikenessError.new('invalid-argument', 'no passphrase was given', 'run it again, and type one')
      end
      if first != ask.prompt.call('the same passphrase again')
        raise LikenessError.new('invalid-argument', 'the two passphrases differ', 'run it again')
      end

      return first
    end
    if flagged.nil?
      raise LikenessError.new('invalid-argument', "no passphrase for the new key: #{fallback} #{NOT_A_TERMINAL}",
                              "set #{fallback}, or name another variable with --#{flag}")
    end
    raise LikenessError.new('invalid-argument',
                            "no passphrase for the new key: the variable --#{flag} names #{NOT_A_TERMINAL}",
                            'set that variable, or run on a terminal to be asked')
  end

  def opened(entry, phrase)
    vault = VoxgigSekreto.openvault('file' => entry.file, 'key' => entry.key, 'passphrase' => phrase)
    begin
      [vault, vault.open]
    rescue StandardError
      raise LikenessError.new('vault-locked',
                              "the vault does not open as the key #{entry.key}: the passphrase is wrong, " \
                              'the key is not there, or the file is damaged',
                              'check the passphrase, and the key --vault-key names')
    end
  end

  def written(entry)
    yield
  rescue StandardError
    raise LikenessError.new('secret-backend-unavailable', 'the vault could not be written',
                            "check that #{File.dirname(entry.shown)} is writable and its disk has space")
  end

  def master(info, action)
    return if info['master']

    raise LikenessError.new('vault-denied', "`secrets #{action}` needs a master key, and #{info['key']} is restricted",
                            'run it as the master key, with --vault-key')
  end

  def denied(message, remedy)
    LikenessError.new('vault-denied', message, remedy)
  end

  def code_point_sorted(names)
    names.sort { |a, b| compare_code_points(a, b) }
  end

  def role(k)
    if k['master'] then 'master'
    elsif k['write'] then 'write'
    else 'read'
    end
  end

  # Padded as JavaScript pads, by UTF-16 code unit.
  def units(text)
    text.encode('UTF-16LE').bytesize / 2
  end

  def not_readable(name, key)
    LikenessError.new('not-found', "the vault has no #{name} that the key #{key} can read",
                      'run `likeness secrets list` for the names it can read')
  end

  # The chain station resolves a live connection's token through. Offline, the
  # SDKs' test transport answers and nothing is resolved, so the chain is empty.
  def vault_chain(ask, entry, flags)
    present(entry)
    phrase = passphrase(ask, flags, entry.key)
    opened(entry, phrase)[0].close
    [{ 'kind' => 'minivault', 'file' => entry.file, 'vaultkey' => entry.key, 'passphrase' => phrase }]
  end

  def init_vault(entry, ask, flags)
    if File.exist?(entry.file)
      raise LikenessError.new('vault-exists', "#{entry.shown} already exists, and init never overwrites it",
                              'use the vault that is there, or name another file in station.json')
    end
    phrase = new_passphrase(ask, flags.passphrase_env, PASSPHRASE_ENV, 'passphrase-env',
                            "new passphrase for #{entry.key}")
    written(entry) do
      FileUtils.mkdir_p(File.dirname(entry.file), mode: 0o700)
      VoxgigSekreto.createvault('file' => entry.file, 'key' => entry.key, 'passphrase' => phrase).close
    end
    Answer.new(data: { 'file' => entry.shown, 'key' => entry.key }, count: 1,
               text: "created the vault #{entry.shown}, with the key #{entry.key}\n")
  end

  def secrets(action, args, entry, ask, flags)
    return init_vault(entry, ask, flags) if 'init' == action

    present(entry)
    if 'set' == action && '-' != args[1] && true != ask.tty
      raise LikenessError.new('invalid-argument',
                              '`secrets set` reads the value from a terminal, or from stdin given as -',
                              'pipe the value in, with - after the name')
    end

    vault, info = opened(entry, passphrase(ask, flags, entry.key))
    begin
      secrets_action(action, args, entry, ask, flags, vault, info)
    ensure
      vault.close
    end
  end

  def secrets_action(action, args, entry, ask, flags, vault, info)
    name = args[0]
    case action
    when 'list'
      names = code_point_sorted(vault.list)
      Answer.new(data: names, count: names.length, text: names.map { |n| "#{n}\n" }.join, empty: names.empty?)
    when 'get' then get_secret(name, entry, flags, vault)
    when 'set' then set_secret(name, args, entry, ask, vault, info)
    when 'remove'
      master(info, action)
      raise not_readable(name, entry.key) unless vault.list.include?(name)

      written(entry) { vault.remove(name) }
      Answer.new(data: { 'name' => name }, count: 1, text: "removed #{name}\n")
    when 'keys'
      master(info, action)
      key_rows(vault)
    when 'grant'
      master(info, action)
      grant_key(args, entry, ask, flags, vault)
    when 'revoke'
      master(info, action)
      revoke_key(name, entry, vault)
    when 'rotate'
      master(info, action)
      dropped = code_point_sorted(vault.keys.map { |k| k['key'] }.reject { |k| k == entry.key })
      written(entry) { vault.rotate }
      Answer.new(data: { 'dropped' => dropped }, count: 1,
                 text: "rotated the vault#{dropped.empty? ? '' : "; dropped #{dropped.join(', ')}"}\n")
    else raise "no such secrets action: #{action}"
    end
  end

  def get_secret(name, entry, flags, vault)
    value = vault.get(name)
    raise not_readable(name, entry.key) if value.nil?
    return Answer.new(data: { 'name' => name, 'value' => value }, count: 1, text: "#{value}\n") if flags.reveal

    Answer.new(data: { 'name' => name }, count: 1, text: "#{name} is set; --reveal prints its value\n")
  end

  def set_secret(name, args, entry, ask, vault, info)
    unless info['master']
      unless info['write']
        raise denied("the key #{entry.key} is read-only", 'run it as the master key, or as one granted --write')
      end
      unless info['grants'].include?(name)
        raise denied("the key #{entry.key} was not granted #{name}",
                     'run it as the master key, or as a key granted that name')
      end
      unless vault.list.include?(name)
        raise denied("only a master key creates a secret, and #{name} is not in the vault",
                     'set it once as the master key')
      end
    end
    given = '-' == args[1] ? ask.stdin&.call : ask.prompt&.call("value for #{name}")
    # One line ending goes: `echo token |` should store the token.
    value = (given || '').sub(/\r?\n\z/, '')
    if value.empty?
      raise LikenessError.new('invalid-argument', 'the value is empty',
                              'a secret needs a value; `likeness secrets remove` drops one')
    end

    written(entry) { vault.set(name, value) }
    Answer.new(data: { 'name' => name }, count: 1, text: "set #{name}\n")
  end

  def key_rows(vault)
    keys = vault.keys.sort { |a, b| compare_code_points(a['key'], b['key']) }.map do |k|
      { 'grants' => k['grants'], 'key' => k['key'], 'master' => k['master'], 'write' => k['write'] }
    end
    width = keys.map { |k| units(k['key']) }.max
    text = keys.map do |k|
      line = "#{k['key']}#{' ' * (width - units(k['key']))}  #{role(k).ljust(6)}  #{k['grants'].join(', ')}"
      "#{line.rstrip}\n"
    end
    Answer.new(data: keys, count: keys.length, text: text.join)
  end

  def grant_key(args, entry, ask, flags, vault)
    key = args[0]
    names = code_point_sorted(args[1..].uniq)
    if vault.keys.any? { |k| k['key'] == key }
      raise LikenessError.new('vault-exists', "the vault already has a key #{key}",
                              'revoke it first, or choose another name')
    end

    phrase = new_passphrase(ask, flags.new_passphrase_env, NEW_PASSPHRASE_ENV, 'new-passphrase-env',
                            "passphrase for the new key #{key}")
    written(entry) { vault.grant('key' => key, 'passphrase' => phrase, 'names' => names, 'write' => flags.write) }
    Answer.new(data: { 'grants' => names, 'key' => key, 'write' => flags.write }, count: 1,
               text: "granted #{key}, #{flags.write ? 'reading and writing ' : 'reading '}#{names.join(', ')}\n")
  end

  def revoke_key(key, entry, vault)
    if entry.key == key
      raise denied("#{key} cannot revoke itself", '`likeness secrets rotate` withdraws every other key')
    end
    unless vault.keys.any? { |k| k['key'] == key }
      raise LikenessError.new('not-found', "the vault has no key #{key}",
                              'run `likeness secrets keys` for the keys there are')
    end

    written(entry) { vault.revoke(key) }
    Answer.new(data: { 'key' => key }, count: 1, text: "revoked #{key}\n")
  end
end
