# frozen_string_literal: true

require_relative '../sdk'

Likeness.require_sdk('Obsidian_sdk')

require_relative '../caps'
require_relative '../envelope'
require_relative '../errors'
require_relative '../identity'
require_relative '../pin'

module Likeness
  module Obsidian
    SOURCE = 'obsidian'
    SUPPLIES = %w[source instance space title body tag created updated].freeze

    SDK = ObsidianSDK

    # The one representation of a note that carries its frontmatter, tags and stat.
    NOTE_JSON = 'application/vnd.olrapi.note+json'

    BUG = 'this is a bug in the source or its SDK; run with --raw to capture the payload'

    UNRESERVED = /[A-Za-z0-9._~-]/

    REFUSED = {
      'changed' => 'presented a certificate whose fingerprint is not the one its connection pins',
      'expired' => 'presented its pinned certificate, which has expired',
      'not-yet-valid' => 'presented its pinned certificate, which is not valid yet',
      'wrong-host' => 'presented its pinned certificate, which does not name the host connected to',
      'invalid' => 'presented a certificate that failed verification',
    }.freeze

    Handle = Struct.new(:sdk, :plain, :instance, keyword_init: true)

    module_function

    def ms(value)
      return value if value.is_a?(Integer)
      return value.to_i if value.is_a?(Float) && value.finite? && value == value.truncate

      0
    end

    # How a connection reaches the plugin, from its block in station.json. HTTPS,
    # the plugin's default, is trusted only with a pinned certificate; plain HTTP
    # only where the block says so. Anything else is refused before any call.
    def transport(instance, block)
      named = "#{SOURCE} connection \"#{instance}\""
      pin = "pin its certificate under sdk.#{instance} in station.json: " \
            '"options": { "tls": { "fingerprint": "sha256:<hex>" } }'
      refuse = ->(what, remedy = pin) { LikenessError.new('invalid-project', "#{named} #{what}", remedy) }

      options = block['options'].nil? ? {} : block['options']
      raise refuse.call('has options that are not a map', 'its options take tls alone') unless options.is_a?(Hash)

      extra = options.keys.reject { |k| 'tls' == k }.min { |a, b| Likeness.compare_code_points(a, b) }
      raise refuse.call("has an option likeness does not read: \"#{extra}\"", 'its options take tls alone') if extra

      base = block['base'].nil? ? 'https://' : Likeness.text_of(block['base']).downcase
      secure = base.start_with?('https://')
      if !secure && !base.start_with?('http://')
        raise refuse.call('has a base that is neither https nor http',
                          "name the plugin's address, as https://127.0.0.1:27124")
      end

      declared = options.key?('tls')
      tls = options['tls']
      if false == tls
        raise refuse.call('turns TLS off on an https base, and verification is never turned off') if secure

        return { 'tls' => 'off' }
      end
      unless secure
        raise refuse.call(declared ? 'pins a certificate on a plain HTTP base' : 'is plain HTTP and does not declare it',
                          'declare plain HTTP with "options": { "tls": false }, ' \
                          "or use the plugin's HTTPS base with a pinned certificate")
      end
      raise refuse.call("pins no certificate, and the plugin's certificate is self-signed") unless declared
      unless tls.is_a?(Hash) && ['fingerprint'] == tls.keys
        raise refuse.call('has a tls option that is neither a pinned fingerprint nor false')
      end

      begin
        { 'tls' => 'pinned', 'pin' => Likeness.parse_pin(tls['fingerprint']) }
      rescue PinError
        raise refuse.call('pins a fingerprint that is not sha256 and 64 hex digits')
      end
    end

    def configure(instance, block)
      transport(instance, block)
    end

    PLAIN = 'http://127.0.0.1:27123'

    # The block `sources add` writes. An https base is pinned to the certificate
    # it presents, which --fingerprint names or a terminal confirms: never one
    # taken on trust because it answered first.
    def setup(instance, given, ask)
      base = given['base'].to_s
      return plain_setup(base, given) if true == given['plain-http']
      unless base.start_with?('https://')
        raise Likeness.bad('an http base is plain HTTP, which only --plain-http declares',
                           "add --plain-http, or give the plugin's HTTPS address with --base")
      end

      pin = given_pin(given['fingerprint'], ask)
      named = "#{SOURCE} at #{base}"
      detail = { 'source' => SOURCE, 'instance' => instance }
      presented = begin
        ask.presented.call(base)
      rescue StandardError
        raise LikenessError.new('source-unavailable', "nothing at #{base} presented a certificate",
                                'start Obsidian with the Local REST API community plugin enabled, ' \
                                'or give its address with --base', detail)
      end
      if !pin.nil? && pin != presented
        raise LikenessError.new('certificate-rejected',
                                "#{named} presents #{presented}, not the certificate --fingerprint names",
                                "check the fingerprint against the plugin's certificate; " \
                                'if it was regenerated, pass the new one', detail)
      end
      if pin.nil? && !ask.confirm.call("#{named} presents #{presented}; type yes to pin it")
        raise LikenessError.new('certificate-rejected', "the certificate #{named} presents was not confirmed",
                                "check it against the plugin's certificate, and run it again to pin it", detail)
      end
      { 'base' => base, 'options' => { 'tls' => { 'fingerprint' => presented } } }
    end

    def plain_setup(base, given)
      unless given['fingerprint'].nil?
        raise Likeness.bad('--plain-http and --fingerprint contradict each other: plain HTTP pins no certificate',
                           'give one of them')
      end
      unless base.start_with?('http://')
        raise Likeness.bad('--plain-http needs an http base',
                           "give the plugin's HTTP address with --base, such as #{PLAIN}")
      end

      { 'base' => base, 'options' => { 'tls' => false } }
    end

    # The pin --fingerprint names, or nil where a terminal is to confirm the one presented.
    def given_pin(fingerprint, ask)
      unless fingerprint.nil?
        begin
          return Likeness.parse_pin(fingerprint)
        rescue PinError
          raise Likeness.bad('--fingerprint is not sha256: and 64 hex digits',
                             "give the certificate's SHA-256, as sha256:<hex>")
        end
      end
      return nil if ask.tty

      raise Likeness.bad("pinning the plugin's certificate needs --fingerprint, or a terminal to confirm it on",
                         'pass --fingerprint sha256:<hex>; ' \
                         '`openssl x509 -noout -fingerprint -sha256 -in obsidian-local-rest-api.crt` prints it')
    end

    def connect(station, conn, config, seed = nil)
      feature = { 'station' => { 'instance' => conn.instance } }
      options = { 'headers' => { 'accept' => NOTE_JSON }, 'feature' => feature }
      if !seed.nil?
        feature['test'] = seed.merge('active' => true)
      elsif 'pinned' == config['tls']
        options['utility'] = { 'fetcher' => Pin.fetcher(config['pin']) }
      end
      Handle.new(sdk: station.connect(SDK, options), plain: 'off' == config['tls'], instance: conn.instance)
    end

    # Every byte but the unreserved characters of RFC 3986 percent-encoded, hex in capitals.
    def percent_encode(text)
      text.b.each_char.map { |c| UNRESERVED.match?(c) ? c : format('%%%02X', c.ord) }.join
    end

    # Obsidian's own URI: the vault by its id, which is the connection's account.
    def note_url(vault, path)
      "obsidian://open?vault=#{percent_encode(vault)}&file=#{percent_encode(path)}"
    end

    # A listing's entries, as the plugin lists one directory: by first segment, a
    # directory with its slash, each once, in code-point order. The plugin names
    # one level as text; the SDK's offline transport lists every record of the
    # entity by id, and the same rule walks both to the same tree.
    def entries(listed)
      out = listed.map do |e|
        name = if e.is_a?(String) then e
               elsif e.is_a?(Hash) && e['id'].is_a?(String) then e['id']
               end
        segs = name.nil? ? [] : name.split('/', -1)
        if name.nil? || name.empty? || segs.each_with_index.any? { |g, i| bad_segment?(g, i, segs.length) }
          raise LikenessError.new('source-unavailable',
                                  "#{SOURCE} returned a vault listing with an entry that names no path below it", BUG)
        end
        1 == segs.length ? segs[0] : "#{segs[0]}/"
      end
      out.uniq.sort { |a, b| Likeness.compare_code_points(a, b) }
    end

    def bad_segment?(seg, index, count)
      '.' == seg || '..' == seg || (seg.empty? && index != count - 1)
    end

    def stamp(value, field)
      Likeness.rfc3339(ms(value))
    rescue RangeError
      raise LikenessError.new('source-unavailable',
                              "#{SOURCE} returned a note whose #{field} is outside the years 0000 to 9999", BUG)
    end

    # Absent is fetched and empty; a null entry is dropped, any other is its text.
    def tags_of(value)
      return [] if value.nil?

      (value.is_a?(Array) ? value : [value]).compact.map { |t| Likeness.text_of(t) }
    end

    def project(raw, path, instance, account, with_raw)
      raise LikenessError.new('source-unavailable', "#{SOURCE} returned a note that is not a record", BUG) unless raw.is_a?(Hash)

      at = path.rindex('/') || -1
      stat = raw['stat'].is_a?(Hash) ? raw['stat'] : {}
      stop = path.length - '.md'.length
      note = {
        'lid' => Likeness.lid(SOURCE, account, 'note', path),
        'source' => SOURCE,
        'instance' => instance,
        'id' => path,
        'title' => stop > at + 1 ? path[(at + 1)...stop] : '',
        'url' => note_url(account, path),
        'created' => stamp(stat['ctime'], 'stat.ctime'),
        'updated' => stamp(stat['mtime'], 'stat.mtime'),
        'tags' => tags_of(raw['tags']),
      }
      note['space'] = path[0...at] if at.positive?
      note['body'] = Likeness.text_of(raw['content']) unless raw['content'].nil?
      note['raw'] = Likeness.render_raw(raw) if with_raw
      note
    end

    def data(entity)
      entity.respond_to?(:data_get) ? entity.data_get : entity
    end

    def not_found?(err)
      404 == Likeness.status_of(err)
    end

    def rejected(instance, err)
      LikenessError.new('certificate-rejected', "#{SOURCE} connection \"#{instance}\" #{REFUSED.fetch(err.refusal)}",
                        "if the plugin's certificate was regenerated, pin its new fingerprint in station.json; " \
                        'if not, do not connect',
                        { 'source' => SOURCE, 'instance' => instance })
    end

    # A note is a `.md` file, by its path from the vault root.
    def note?(path)
      path.end_with?('.md')
    end

    def listing(handle, dir)
      return entries((handle.sdk.Vault.list || []).map { |e| data(e) }) if dir.empty?

      got = data(handle.sdk.Vault.load({ 'id' => dir }))
      unless got.is_a?(Hash) && got['files'].is_a?(Array)
        raise LikenessError.new('source-unavailable', "#{SOURCE} returned a directory with no list of files", BUG)
      end

      entries(got['files'])
    rescue CertificateError => e
      raise rejected(handle.instance, e)
    rescue StandardError => e
      return [] if not_found?(e)

      raise
    end

    def read(handle, conn, path, with_raw)
      raw = data(handle.sdk.Vault.load({ 'id' => path }))
      project(raw, path, conn.instance, conn.account, with_raw)
    rescue CertificateError => e
      raise rejected(handle.instance, e)
    rescue StandardError => e
      return nil if not_found?(e)

      raise
    end

    # The walk, as the plugin lets a vault be walked: one directory at a time,
    # depth first, each directory's entries in code-point order, and each note
    # read as it is met. The block answers a list step with that directory's entries.
    def walk_steps(dir = '', &visit)
      (visit.call({ 'list' => dir }) || []).each do |name|
        path = dir + name
        if name.end_with?('/')
          walk_steps(path, &visit)
        elsif note?(path)
          visit.call({ 'read' => path })
        end
      end
    end

    # A directory or a note gone since its parent was listed is skipped.
    def walk_notes(handle, conn, with_raw, limit)
      notes = []
      more = catch(:full) do
        walk_steps do |step|
          next listing(handle, step['list']) if step.key?('list')
          throw :full, true if limit.positive? && notes.length >= limit

          note = read(handle, conn, step['read'], with_raw)
          notes << note unless note.nil?
          nil
        end
        false
      end
      { notes: notes, more: more }
    end

    def list_notes(handle, conn, with_raw)
      walk_notes(handle, conn, with_raw, Likeness.page_max(SOURCE))
    end

    def load_note(handle, conn, id, with_raw)
      segs = id.split('/', -1)
      if segs.each_with_index.any? { |g, i| bad_segment?(g, i, segs.length) }
        raise LikenessError.new('invalid-ref',
                                "not a ref: #{conn.instance}:#{id} (a vault path has no empty, . or .. segment)",
                                'a ref is <instance>:<id>, a lid, #n or @alias')
      end
      unless note?(id)
        raise LikenessError.new('not-found', "#{conn.instance}:#{id} is not a note, which is a .md file",
                                'check the ref, or run `likeness list` to see what is there')
      end

      read(handle, conn, id, with_raw)
    end

    def check(handle)
      how = handle.plain ? ', over plain HTTP as the connection declares' : ''
      begin
        handle.sdk.Vault.list
        { ok: true, detail: "ok#{how}" }
      rescue CertificateError => e
        r = rejected(handle.instance, e)
        { ok: false, code: r.code, detail: REFUSED.fetch(e.refusal), remedy: r.remedy }
      rescue StandardError => e
        # An empty vault lists as not found, which only a token the plugin accepted can reach.
        return { ok: true, detail: "ok#{how}" } if not_found?(e)

        case Likeness.status_of(e)
        when 401, 403 then { ok: false, code: 'auth-failed', detail: "the token was rejected#{how}" }
        when 429 then { ok: false, code: 'rate-limited', detail: "the source is rate limiting this client#{how}" }
        else
          { ok: false, code: 'source-unavailable', detail: "the application did not answer#{how}",
            remedy: 'start Obsidian with the Local REST API community plugin enabled' }
        end
      end
    end
  end
end
