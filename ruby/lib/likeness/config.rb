# frozen_string_literal: true

require 'json'

require_relative 'envelope'
require_relative 'station'

module Likeness
  class ConfigError < StandardError; end

  CONFIG_REMEDY = 'fix the file, or point --config at another'
  # Ruby's JSON.parse also reads comments and unknown escapes, which JSON and
  # the other ports refuse.
  NOT_JSON = %r{"(?:[^"\\]|\\["\\/bfnrt]|\\u\h{4}|(\\))*"?|(/)}

  CONFIG_DEPTH = 64

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

  def load_config(path, profile)
    source = read_config(path)
    return [nil, {}] if source.nil?

    station = parse_station(source, path)
    lpath = File.join(File.dirname(path), 'likeness.json')
    lsource = read_config(lpath)
    [station, lsource.nil? ? {} : parse_accounts(lsource, lpath, profile)]
  end
end
