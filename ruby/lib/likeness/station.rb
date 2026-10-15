# frozen_string_literal: true

require 'voxgig_station'

require_relative 'errors'

module Likeness
  Connection = Struct.new(:instance, :source, :account, keyword_init: true)

  module_function

  def profile_of(env)
    profile = env&.fetch('VOXGIG_STATION_PROFILE', nil)
    profile.nil? || profile.empty? ? 'default' : profile
  end

  def open_station(config, env = nil)
    VoxgigStation::Station.new('config' => config, 'profile' => profile_of(env), 'proxy' => 'off', 'load' => false)
  end

  # station.json with its secret chain replaced, in every profile, by the one
  # likeness decided on.
  def with_chain(config, chain)
    return config unless config.is_a?(Hash)

    copy = Marshal.load(Marshal.dump(config))
    profiles = copy['profiles']
    (profiles.is_a?(Hash) ? profiles.values : []).each do |p|
      p['secrets'] = { 'providers' => chain } if p.is_a?(Hash)
    end
    copy
  end

  # Every declared active instance, in station's ref order, with the account
  # its notes' identity derives from. Identity is never derived from the ref.
  def connections_of(station, accounts, profile)
    station.instances.select { |i| i['active'] }.map do |i|
      name = i['name']
      account = accounts[name]
      unless account.is_a?(String) && !account.empty?
        raise LikenessError.new('invalid-project',
                                "instance \"#{name}\" has no account in likeness.json under profile \"#{profile}\"",
                                "add `\"#{name}\": { \"account\": \"<id>\" }` under " \
                                "`profiles.#{profile}.instances` in likeness.json")
      end
      Connection.new(instance: name, source: i['api'], account: account)
    end
  end
end
