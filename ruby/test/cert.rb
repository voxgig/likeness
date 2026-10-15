# frozen_string_literal: true

require 'openssl'

# Certificates made at test time, never read from disk or the network.
module Cert
  DAY = 86_400

  Throwaway = Struct.new(:pkey, :x509, keyword_init: true) do
    def key
      pkey.private_to_pem
    end

    def cert
      x509.to_pem
    end

    def der
      x509.to_der
    end
  end

  @serial = 0

  # A self-signed certificate for 127.0.0.1, as the Obsidian plugin makes one:
  # its own authority, naming the address it serves. `days` places its validity
  # around now: [-1, 2] is current, [-3, -1] has expired.
  def self.self_signed(days = [-1, 2], address: '127.0.0.1')
    pkey = OpenSSL::PKey::EC.generate('prime256v1')
    name = OpenSSL::X509::Name.new([['CN', address]])
    x509 = OpenSSL::X509::Certificate.new
    x509.version = 2
    x509.serial = (@serial += 1)
    x509.subject = name
    x509.issuer = name
    x509.public_key = pkey
    now = Time.now
    x509.not_before = now + (days[0] * DAY)
    x509.not_after = now + (days[1] * DAY)
    extensions = OpenSSL::X509::ExtensionFactory.new(x509, x509)
    x509.add_extension(extensions.create_extension('basicConstraints', 'CA:TRUE', true))
    x509.add_extension(extensions.create_extension('subjectAltName', "IP:#{address}", false))
    x509.sign(pkey, OpenSSL::Digest.new('SHA256'))
    Throwaway.new(pkey: pkey, x509: x509)
  end
end
