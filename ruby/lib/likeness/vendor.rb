# frozen_string_literal: true

module Likeness
  # Linked by `make rb-deps`: the SDK clone `make sdk` pins, and the library
  # checkouts ruby/libs.json pins. None of them is published as a gem.
  VENDOR = File.expand_path('../../vendor', __dir__)

  %w[joplin-sdk/rb station/ruby/lib sekreto/ruby/lib plugin/ruby/lib].each do |dir|
    path = File.join(VENDOR, dir)
    raise LoadError, "likeness: #{path} is missing - run `make rb-deps`" unless File.directory?(path)

    $LOAD_PATH.unshift(path) unless $LOAD_PATH.include?(path)
  end
end
