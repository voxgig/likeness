# frozen_string_literal: true

require 'json'

module Likeness
  # The copies `make spec-build` writes beside this file, so an installed port
  # reads no specification from a checkout.
  module Spec
    DIR = File.join(__dir__, 'spec')

    def self.load(name)
      JSON.parse(File.read(File.join(DIR, "#{name}.json"), encoding: 'UTF-8'))
    end
  end
end
