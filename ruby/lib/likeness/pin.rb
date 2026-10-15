# frozen_string_literal: true

require 'digest'
require 'json'
require 'net/http'
require 'openssl'
require 'uri'

module Likeness
  PIN_RE = /\Asha256:(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){31})\z/

  class PinError < StandardError; end

  # A refusal of the certificate a server presented: changed, expired,
  # not-yet-valid, wrong-host or invalid.
  class CertificateError < StandardError
    attr_reader :refusal

    def initialize(refusal)
      super("the certificate was refused: #{refusal}")
      @refusal = refusal
    end
  end

  module_function

  # `sha256:` and the hex digest, bare or as colon-joined pairs, either case.
  def parse_pin(text)
    raise PinError, 'not a sha256 certificate fingerprint' unless text.is_a?(String) && PIN_RE.match?(text)

    "sha256:#{text.delete_prefix('sha256:').delete(':').downcase}"
  end

  def fingerprint_of(der)
    "sha256:#{Digest::SHA256.hexdigest(der)}"
  end

  # The fingerprint of the certificate an https base presents, by the probe the
  # pinned transport uses, so pinning it writes nothing to the server either.
  def presented_fingerprint(base)
    uri = URI.parse(base)
    raise CertificateError, 'invalid' unless 'https' == uri.scheme&.downcase

    fingerprint_of(Pin.presented(uri).to_der)
  end

  # A transport for the SDK's `utility.fetcher` seam that trusts exactly the
  # certificate whose SHA-256 fingerprint is the pin. No request byte is written
  # before the presented certificate has matched it.
  module Pin
    VERIFY_ERRORS = OpenSSL::X509.constants.grep(/\AV_ERR_/)
                                 .to_h { |c| [OpenSSL::X509.const_get(c), c.to_s.delete_prefix('V_ERR_')] }.freeze

    METHODS = { 'POST' => Net::HTTP::Post, 'PUT' => Net::HTTP::Put, 'DELETE' => Net::HTTP::Delete,
                'PATCH' => Net::HTTP::Patch }.freeze

    module_function

    def fetcher(pin)
      anchor = nil
      lambda do |_ctx, fullurl, fetchdef|
        uri = URI.parse(fullurl)
        raise CertificateError, 'invalid' unless 'https' == uri.scheme&.downcase

        if anchor.nil?
          cert = presented(uri)
          raise CertificateError, 'changed' unless pin == Likeness.fingerprint_of(cert.to_der)

          anchor = cert
        end
        begin
          exchange(uri, anchor, pin, fetchdef)
        rescue CertificateError
          anchor = nil
          raise
        end
      rescue CertificateError
        raise
      rescue StandardError => e
        [nil, "#{e.class}: #{e.message}"]
      end
    end

    def refusal_of(code)
      name = VERIFY_ERRORS.fetch(code, '')
      return 'expired' if 'CERT_HAS_EXPIRED' == name
      return 'not-yet-valid' if 'CERT_NOT_YET_VALID' == name
      return 'wrong-host' if 'HOSTNAME_MISMATCH' == name

      # Any other chain failure means the anchor is not what was presented.
      /SELF_SIGNED|ISSUER|LEAF_SIGNATURE|UNTRUSTED/.match?(name) ? 'changed' : 'invalid'
    end

    # Direct, never through a proxy, and verifying the peer against `store` alone.
    def client(uri, store)
      http = Net::HTTP.new(uri.hostname, uri.port, nil)
      http.use_ssl = true
      http.verify_mode = OpenSSL::SSL::VERIFY_PEER
      http.verify_hostname = true
      http.cert_store = store
      http.max_retries = 0
      http
    end

    # The certificate a server presents, read during a handshake that an empty
    # trust store refuses, so it never completes and nothing is written on it.
    def presented(uri)
      leaf = nil
      http = client(uri, OpenSSL::X509::Store.new)
      http.verify_callback = lambda do |_ok, context|
        leaf ||= context.chain&.first
        false
      end
      failure = nil
      begin
        http.start { nil }
      rescue StandardError => e
        failure = e
      end
      return leaf unless leaf.nil?
      raise failure unless failure.nil?

      raise CertificateError, 'invalid'
    end

    # Verified by OpenSSL against the pinned certificate as the only trust
    # anchor, with its host check, and then against the pin itself.
    def exchange(uri, anchor, pin, fetchdef)
      store = OpenSSL::X509::Store.new
      store.add_cert(anchor)
      http = client(uri, store)
      seen = {}
      http.verify_callback = lambda do |ok, context|
        seen[:leaf] ||= context.chain&.first
        seen[:error] ||= context.error unless ok
        ok
      end
      begin
        http.start do
          raise CertificateError, 'changed' unless pin == Likeness.fingerprint_of(http.peer_cert.to_der)

          response(http.request(request_of(uri, fetchdef)))
        end
      rescue OpenSSL::SSL::SSLError
        raise CertificateError, refusal_of(seen[:error]) unless seen[:error].nil?
        # Net::HTTP checks an IP address only once the handshake is done.
        unless seen[:leaf].nil? || OpenSSL::SSL.verify_certificate_identity(seen[:leaf], uri.hostname)
          raise CertificateError, 'wrong-host'
        end

        raise
      end
    end

    def request_of(uri, fetchdef)
      request = METHODS.fetch((fetchdef['method'] || 'GET').to_s.upcase, Net::HTTP::Get).new(uri)
      (fetchdef['headers'] || {}).each { |name, value| request[name] = value if value.is_a?(String) }
      body = fetchdef['body']
      if body.is_a?(String)
        request.body = body
      elsif body.respond_to?(:read)
        request.body_stream = body
        if body.respond_to?(:size)
          request['content-length'] = body.size.to_s
        else
          request['transfer-encoding'] = 'chunked'
        end
      end
      request
    end

    # The response as the SDK's own transport hands it on.
    def response(res)
      headers = {}
      res.each_header { |name, value| headers[name.downcase] = value }
      body = res.body
      json = nil
      unreadable = false
      begin
        json = JSON.parse(body) unless body.nil? || body.strip.empty?
      rescue JSON::ParserError
        unreadable = true
      end
      [{ 'status' => res.code.to_i, 'statusText' => res.message, 'headers' => headers,
         'json' => -> { json }, 'body' => body, 'unreadable' => unreadable }, nil]
    end
  end
end
