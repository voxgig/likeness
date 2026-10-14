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

  def rfc3339(ms)
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
end
