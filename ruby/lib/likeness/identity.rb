# frozen_string_literal: true

require 'digest'

module Likeness
  CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

  module_function

  # Crockford base32, lowercase, big-endian bit order, unpadded, cut at `chars`.
  def crockford32(bytes, chars)
    out = +''
    acc = 0
    bits = 0
    bytes.each_byte do |b|
      acc = ((acc << 8) | b) & 0xffff
      bits += 8
      while 5 <= bits
        bits -= 5
        out << CROCKFORD[(acc >> bits) & 31]
        return out if out.length == chars
      end
    end
    out << CROCKFORD[(acc << (5 - bits)) & 31] if bits.positive? && out.length < chars
    out[0, chars]
  end

  # The NUL separators keep ("ab", "c") and ("a", "bc") apart.
  def lid(source, account, entity, id)
    "lk_#{crockford32(Digest::SHA256.digest([source, account, entity, id].join("\0")), 12)}"
  end

  # The first and last instants with a four-digit year: outside them an
  # instant is refused, never written some other way.
  RFC3339_MIN = -62_167_219_200_000
  RFC3339_MAX = 253_402_300_799_999

  def rfc3339(ms)
    if !ms.is_a?(Numeric) || (ms.is_a?(Float) && !ms.finite?) || ms < RFC3339_MIN || RFC3339_MAX < ms
      raise RangeError, "rfc3339: #{ms} ms is outside the years 0000 to 9999"
    end

    Time.at(Rational(ms, 1000)).utc.strftime('%Y-%m-%dT%H:%M:%SZ')
  end

  RFC3339_RE = /\A(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z\z/

  # Milliseconds since the epoch, or nil for anything not in the form rfc3339
  # writes.
  def parse_rfc3339(text)
    m = RFC3339_RE.match(text.to_s)
    return nil if m.nil?

    parts = m.captures.map(&:to_i)
    time = Time.utc(*parts)
    return nil unless [time.year, time.month, time.day, time.hour, time.min, time.sec] == parts

    time.to_i * 1000
  rescue ArgumentError
    nil
  end

  INSTANT_RE = /\A([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))\z/

  def days_from_civil(year, month, day)
    y = month <= 2 ? year - 1 : year
    era = y.div(400)
    yoe = y - (era * 400)
    doy = (((153 * (month + (month > 2 ? -3 : 9))) + 2) / 5) + day - 1
    (era * 146_097) + (yoe * 365) + (yoe / 4) - (yoe / 100) + doy - 719_468
  end

  MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].freeze

  def leap?(year)
    (0 == year % 4 && 0 != year % 100) || 0 == year % 400
  end

  def days_in(year, month)
    2 == month && leap?(year) ? 29 : MONTH_DAYS[month - 1]
  end

  # Any RFC 3339 date-time, its fraction dropped and its offset applied, as
  # milliseconds since the epoch; nil for text that is not one.
  def parse_instant(text)
    m = INSTANT_RE.match(text)
    return nil if m.nil?

    year, month, day, hour, minute, second = m.captures[0, 6].map(&:to_i)
    return nil if month < 1 || month > 12 || day < 1 || days_in(year, month) < day
    return nil if hour > 23 || minute > 59 || second > 59

    offset = 0
    unless m[7].nil?
      oh = m[8].to_i
      om = m[9].to_i
      return nil if oh > 23 || om > 59

      offset = ('-' == m[7] ? -1 : 1) * ((oh * 60) + om)
    end
    (((((days_from_civil(year, month, day) * 24) + hour) * 60) + minute - offset) * 60_000) + (second * 1000)
  end
end
