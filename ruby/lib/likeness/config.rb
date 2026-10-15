# frozen_string_literal: true

require 'json'
require 'strscan'

require_relative 'envelope'
require_relative 'station'

module Likeness
  class ConfigError < StandardError; end

  CONFIG_REMEDY = 'fix the file, or point --config at another'
  # Ruby's JSON.parse also reads comments and unknown escapes, which JSON and
  # the other ports refuse.
  NOT_JSON = %r{"(?:[^"\\]|\\["\\/bfnrt]|\\u\h{4}|(\\))*"?|(/)}

  CONFIG_DEPTH = 64

  # A file's text, with the bytes and mode it would be put back with.
  Held = Struct.new(:text, :bytes, :mode, keyword_init: true)

  # A configuration file as it is written: each object's keys in the file's
  # order, and each key and scalar as its own text, so a file written back
  # after one change differs from what was read only by that change and by
  # the layout render_doc gives every file.
  module Doc
    Lit = Struct.new(:raw, :v)
    Obj = Struct.new(:m)
    Arr = Struct.new(:v)
    Member = Struct.new(:k, :raw, :v)

    WS = /[ \t\n\r]*/
    STRING = /"(?:[^"\\\u0000-\u001f]|\\["\\\/bfnrt]|\\u\h{4})*"/
    SCALAR = /true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/

    class Syntax < StandardError; end
  end

  # The file operations a configuration write goes through, for a test to make one fail.
  module FileOps
    module_function

    def write(path, data, mode)
      File.open(path, File::WRONLY | File::CREAT | File::EXCL | File::BINARY, mode) { |f| f.write(data) }
    end

    def rename(from, to)
      File.rename(from, to)
    end

    def unlink(path)
      File.unlink(path)
    end
  end

  # One file to replace: its new text, and what it held, nil for a file not there yet.
  Write = Struct.new(:path, :text, :was, keyword_init: true)

  class WriteError < StandardError
    attr_reader :path, :restored

    def initialize(path, restored)
      super("could not write #{path}")
      @path = path
      @restored = restored
    end
  end

  @made = 0

  module_function

  # A number past a double's range: JSON.parse reads it as an infinity, or as an
  # integer no double holds, and the canonical port reads every number as one.
  def finite?(doc)
    pending = [doc]
    until pending.empty?
      value = pending.pop
      case value
      when Float then return false unless value.finite?
      when Integer then return false unless value.to_f.finite?
      when Hash then pending.concat(value.values)
      when Array then pending.concat(value)
      end
    end
    true
  end

  # Counted on the text before it is parsed: each port's parser, and the copy
  # made of station.json, recurse, and each would give out at its own depth.
  def too_deep?(source)
    bytes = source.b
    depth = 0
    quoted = false
    i = 0
    while i < bytes.bytesize
      c = bytes.getbyte(i)
      if quoted
        if 0x5c == c
          i += 1
        elsif 0x22 == c
          quoted = false
        end
      elsif 0x22 == c
        quoted = true
      elsif 0x5b == c || 0x7b == c
        depth += 1
        return true if CONFIG_DEPTH < depth
      elsif (0x5d == c || 0x7d == c) && depth.positive?
        depth -= 1
      end
      i += 1
    end
    false
  end

  def parse_json(source, path)
    raise ConfigError, "#{path} is nested more than #{CONFIG_DEPTH} deep" if too_deep?(source)

    begin
      raise JSON::ParserError if source.scan(NOT_JSON).any? { |escape, slash| escape || slash }

      doc = JSON.parse(source)
      raise JSON::ParserError unless finite?(doc)
    rescue JSON::ParserError
      raise ConfigError, "#{path} is not valid JSON"
    end
    raise ConfigError, "#{path} is not a JSON object" unless doc.is_a?(Hash)

    doc
  end

  # station.json, validated by station against its own shape. Its secret chain
  # is likeness's to check, and is checked when it is used.
  def parse_station(source, path)
    doc = parse_json(source, path)
    begin
      open_station(with_chain(doc, []))
    rescue StandardError => e
      code = e.respond_to?(:code) ? e.code : nil
      raise ConfigError, "#{path}: #{e.message}" if code.is_a?(String) && code.start_with?('station_')

      raise
    end
    doc
  end

  # Read only from an object, so a malformed file is never a crash and an
  # array's indices never stand for names.
  def member_of(value, key)
    value.is_a?(Hash) ? value[key] : nil
  end

  # The account each instance ref of one station profile belongs to, from
  # likeness.json. A profile reads only its own: none is inherited.
  def parse_accounts(source, path, profile)
    instances = member_of(member_of(member_of(parse_json(source, path), 'profiles'), profile), 'instances')
    return {} unless instances.is_a?(Hash)

    instances.keys.sort { |a, b| compare_code_points(a, b) }.each_with_object({}) do |ref, out|
      account = instances[ref].is_a?(Hash) ? instances[ref]['account'] : nil
      out[ref] = text_of(account) unless account.nil?
    end
  end

  # nil when the file is not there. One that is there and cannot be read as a
  # file, such as a directory, is refused rather than taken for absent.
  def read_config(path)
    return nil unless File.exist?(path)

    begin
      File.read(path, encoding: 'UTF-8').scrub
    rescue SystemCallError, IOError
      raise ConfigError, "#{path} cannot be read"
    end
  end

  def held(path, named)
    return nil unless File.exist?(path)

    bytes = File.binread(path)
    Held.new(text: bytes.dup.force_encoding(Encoding::UTF_8).scrub, bytes: bytes, mode: File.stat(path).mode & 0o777)
  rescue SystemCallError, IOError
    raise ConfigError, "#{named} cannot be read"
  end

  def load_config(path, profile)
    source = read_config(path)
    return [nil, {}] if source.nil?

    station = parse_station(source, path)
    lpath = File.join(File.dirname(path), 'likeness.json')
    lsource = read_config(lpath)
    [station, lsource.nil? ? {} : parse_accounts(lsource, lpath, profile)]
  end

  # JSON as JSON.parse reads it, a key given twice keeping its first place and
  # its last value.
  def read_doc(source)
    s = StringScanner.new(source)
    doc = doc_value(s)
    s.skip(Doc::WS)
    raise Doc::Syntax unless s.eos?

    doc
  end

  def doc_next(scan, char)
    scan.skip(Doc::WS)
    return false unless scan.peek(1) == char

    scan.pos += 1
    true
  end

  def doc_value(scan)
    return doc_members(scan) if doc_next(scan, '{')
    return doc_items(scan) if doc_next(scan, '[')

    raw = scan.scan(Doc::STRING) || scan.scan(Doc::SCALAR)
    raise Doc::Syntax if raw.nil?

    value = JSON.parse(raw)
    raise Doc::Syntax unless finite?(value)

    Doc::Lit.new(raw, value)
  end

  def doc_members(scan)
    members = []
    return Doc::Obj.new(members) if doc_next(scan, '}')

    loop do
      scan.skip(Doc::WS)
      raw = scan.scan(Doc::STRING)
      raise Doc::Syntax if raw.nil? || !doc_next(scan, ':')

      key = JSON.parse(raw)
      value = doc_value(scan)
      same = members.find { |x| x.k == key }
      if same.nil?
        members << Doc::Member.new(key, raw, value)
      else
        same.v = value
      end
      break unless doc_next(scan, ',')
    end
    raise Doc::Syntax unless doc_next(scan, '}')

    Doc::Obj.new(members)
  end

  def doc_items(scan)
    items = []
    return Doc::Arr.new(items) if doc_next(scan, ']')

    loop do
      items << doc_value(scan)
      break unless doc_next(scan, ',')
    end
    raise Doc::Syntax unless doc_next(scan, ']')

    Doc::Arr.new(items)
  end

  # Refused as the readers above refuse it, and in their words.
  def parse_doc(source, path)
    raise ConfigError, "#{path} is nested more than #{CONFIG_DEPTH} deep" if too_deep?(source)

    begin
      doc = read_doc(source)
    rescue Doc::Syntax, JSON::ParserError
      raise ConfigError, "#{path} is not valid JSON"
    end
    raise ConfigError, "#{path} is not a JSON object" unless doc.is_a?(Doc::Obj)

    doc
  end

  # JSON.stringify's layout at an indent of 2, over the text each key and scalar had.
  def render_doc(doc)
    "#{laid_out(doc, '')}\n"
  end

  def laid_out(doc, at)
    return doc.raw if doc.is_a?(Doc::Lit)

    inner = "#{at}  "
    if doc.is_a?(Doc::Arr)
      return '[]' if doc.v.empty?

      return "[\n#{doc.v.map { |x| inner + laid_out(x, inner) }.join(",\n")}\n#{at}]"
    end
    return '{}' if doc.m.empty?

    "{\n#{doc.m.map { |x| "#{inner}#{x.raw}: #{laid_out(x.v, inner)}" }.join(",\n")}\n#{at}}"
  end

  # What the next reader of the file will see, which is what station validates.
  def plain_of(doc)
    JSON.parse(render_doc(doc))
  end

  def doc_of(value)
    case value
    when Array then Doc::Arr.new(value.map { |x| doc_of(x) })
    when Hash then Doc::Obj.new(value.map { |k, x| Doc::Member.new(k, escape_string(k), doc_of(x)) })
    else Doc::Lit.new(value.is_a?(String) ? escape_string(value) : render_raw(value), value)
    end
  end

  def member(obj, key)
    obj.m.find { |x| x.k == key }&.v
  end

  # Replaced where it stands, or added last.
  def put(obj, key, value)
    at = obj.m.find { |x| x.k == key }
    if at.nil?
      obj.m << Doc::Member.new(key, escape_string(key), value)
    else
      at.v = value
    end
  end

  def drop(obj, key)
    i = obj.m.index { |x| x.k == key }
    return false if i.nil?

    obj.m.delete_at(i)
    true
  end

  def rekey(obj, from, to)
    at = obj.m.find { |x| x.k == from }
    return if at.nil?

    at.k = to
    at.raw = escape_string(to)
  end

  def temp_of(path)
    @made += 1
    File.join(File.dirname(path), ".#{File.basename(path)}.#{Process.pid}.#{@made}.tmp")
  end

  # Every file replaced, or none. Each new text, and each file's old bytes, is
  # written beside it before anything is renamed into place, so a rename that
  # fails is undone by renames alone. A file that is a symlink is replaced where
  # the link points, so the link survives.
  def write_all(writes, fs = FileOps)
    target = writes.map { |w| !w.was.nil? && File.lstat(w.path).symlink? ? File.realpath(w.path) : w.path }
    temps = []
    place = lambda do |path, data, mode|
      temp = temp_of(path)
      fs.write(temp, data, mode)
      temps << temp
      temp
    end
    clear = lambda do
      temps.each do |temp|
        fs.unlink(temp)
      rescue StandardError
        nil
      end
    end

    fresh = []
    old = []
    at = 0
    begin
      while at < writes.length
        fresh << place.call(target[at], writes[at].text, writes[at].was&.mode || 0o600)
        at += 1
      end
      at = 0
      while at < writes.length
        was = writes[at].was
        old << (was.nil? ? nil : place.call(target[at], was.bytes, was.mode))
        at += 1
      end
    rescue StandardError
      clear.call
      raise WriteError.new(writes[at].path, true)
    end

    writes.each_index do |i|
      fs.rename(fresh[i], target[i])
    rescue StandardError
      restored = true
      (i - 1).downto(0) do |j|
        back = old[j]
        back.nil? ? fs.unlink(target[j]) : fs.rename(back, target[j])
      rescue StandardError
        restored = false
      end
      clear.call
      raise WriteError.new(writes[i].path, restored)
    end
    clear.call
  end
end
