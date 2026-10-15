# frozen_string_literal: true

require_relative 'lib/likeness/version'

Gem::Specification.new do |spec|
  spec.name = 'likeness'
  spec.version = Likeness::VERSION
  spec.summary = 'likeness, Ruby port'
  spec.description = 'One vocabulary, one selector grammar and one output shape over the notes kept in other ' \
                     "people's applications, reached through generated voxgig SDKs bound to voxgig/station."
  spec.authors = ['Voxgig']
  spec.license = 'MIT'
  spec.homepage = 'https://github.com/voxgig/likeness'
  spec.required_ruby_version = '>= 3.3'
  spec.metadata['rubygems_mfa_required'] = 'true'

  # station, sekreto, plugin and the SDK are not published as gems: they are
  # linked under vendor/ by `make rb-deps`, so none is declared here.
  spec.files = Dir.glob(['bin/likeness-rb', 'lib/**/*.rb', 'lib/likeness/spec/*.json'], base: __dir__).sort
  spec.bindir = 'bin'
  spec.executables = ['likeness-rb']
  spec.require_paths = ['lib']
end
