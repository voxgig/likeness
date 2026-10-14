# frozen_string_literal: true

module Likeness
  # The requests a run made, as station observed them at the transport, one per
  # attempt. Tapped rather than read back, because the event ring drops its
  # oldest.
  class Calls
    def initialize(station = nil)
      @list = []
      station&.tap do |e|
        http = e['http']
        next unless 'http' == e['kind'] && !http.nil?

        @list << { 'instance' => e['plugin'].to_s, 'method' => http['method'], 'path' => http['path'] }
      end
    end

    def all
      @list.dup
    end

    def count
      @list.length
    end
  end
end
