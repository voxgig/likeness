# frozen_string_literal: true

module Likeness
  # The largest integer a double holds exactly: JSON numbers are doubles in the
  # canonical port, so a larger one has already lost digits there.
  SAFE_INTEGER = 9_007_199_254_740_991

  PARITY_EXCEPTIONS = ['port', 'meta.elapsed_ms', 'data.port'].freeze

  class SerialiseError < StandardError
    attr_reader :path

    def initialize(message, path)
      super("#{message} at #{path.empty? ? '$' : path}")
      @path = path
    end
  end

  ESCAPED = /["\\\u0000-\u001f]/

  module_function

  def escape_string(text)
    body = text.gsub(ESCAPED) do |ch|
      case ch
      when '"' then '\\"'
      when '\\' then '\\\\'
      else format('\\u%04x', ch.ord)
      end
    end
    "\"#{body}\""
  end

  def compare_code_points(a, b)
    a.codepoints <=> b.codepoints
  end

  # Not `JSON.generate`: its key order is insertion order, which differs per
  # port, and its escapes differ from the envelope's.
  def render(value, path = '', loose = false)
    case value
    when nil then 'null'
    when true then 'true'
    when false then 'false'
    when Integer, Float then render_number(value, path, loose)
    when String then escape_string(value)
    when Array
      parts = value.each_with_index.map { |e, i| render(e, "#{path}[#{i}]", loose) }
      "[#{parts.join(',')}]"
    when Hash
      keys = value.keys.sort { |a, b| compare_code_points(a, b) }
      parts = keys.map { |k| "#{escape_string(k)}:#{render(value[k], "#{path}.#{k}", loose)}" }
      "{#{parts.join(',')}}"
    else
      raise SerialiseError.new("value of unsupported type #{value.class}", path)
    end
  end

  def render_number(value, path, loose)
    if value.is_a?(Integer) && SAFE_INTEGER < value.abs
      return render_number(value.to_f, path, loose) if loose

      raise SerialiseError.new('integer beyond exact double precision - use a bigint', path)
    end
    return value.to_s if value.is_a?(Integer)

    raise SerialiseError.new('non-finite number', path) unless value.finite?
    return js_number(value) if loose
    raise SerialiseError.new('floating point is not representable in the envelope', path) if value != value.truncate
    raise SerialiseError.new('integer beyond exact double precision - use a bigint', path) if SAFE_INTEGER < value.abs

    value.to_i.to_s
  end

  # ECMAScript Number::toString over the shortest round-trip digits, which
  # Float#to_s also produces but formats differently.
  def js_number(value)
    return '0' if value.zero?

    mantissa, exponent = value.abs.to_s.split('e')
    whole, fraction = mantissa.split('.')
    digits = whole + fraction.to_s
    point = whole.length + exponent.to_i
    lead = digits[/\A0*/].length
    digits = digits[lead..].sub(/0+\z/, '')
    point -= lead
    size = digits.length

    text =
      if size <= point && point <= 21
        digits + ('0' * (point - size))
      elsif 0 < point && point <= 21
        "#{digits[0, point]}.#{digits[point..]}"
      elsif -6 < point && point <= 0
        "0.#{'0' * -point}#{digits}"
      else
        power = point - 1
        head = 1 == size ? digits : "#{digits[0]}.#{digits[1..]}"
        "#{head}e#{power.negative? ? '-' : '+'}#{power.abs}"
      end
    value.negative? ? "-#{text}" : text
  end

  # A source payload: floating point permitted, in the canonical port's form.
  def render_raw(value)
    render(value, '', true)
  end

  # A value read as text: a non-string is its canonical JSON.
  def text_of(value)
    value.is_a?(String) ? value : render_raw(value)
  end

  def serialise(value)
    "#{render(value)}\n"
  end

  # By PATH, never by name: a `port` inside a `which` row is compared.
  def strip_parity_exceptions(value)
    return value unless value.is_a?(Hash)

    value.each_with_object({}) do |(key, inner), out|
      next if 'port' == key

      out[key] =
        if ('meta' == key || 'data' == key) && inner.is_a?(Hash)
          drop = 'meta' == key ? 'elapsed_ms' : 'port'
          inner.reject { |k, _| drop == k }
        else
          inner
        end
    end
  end
end
