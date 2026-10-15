# frozen_string_literal: true

require 'net/http'

require_relative 'harness'

# Refuses every real connection while armed, and counts the attempts.
module NetworkGuard
  class << self
    attr_accessor :armed, :reached
  end
  self.armed = false
  self.reached = 0

  def start(*)
    if NetworkGuard.armed
      NetworkGuard.reached += 1
      raise "the offline test blocked a real Net::HTTP call to #{address}:#{port}"
    end
    super
  end
end
Net::HTTP.prepend(NetworkGuard)

class OfflineTest < Minitest::Test
  SEED = {
    'entity' => {
      'note' => {
        'n1' => { 'id' => 'n1', 'title' => 'seeded', 'body' => 'one', 'parent_id' => 'f1', 'updated_time' => 1 },
        'n2' => { 'id' => 'n2', 'title' => 'also seeded', 'body' => 'two', 'parent_id' => 'f1', 'updated_time' => 2 },
      },
    },
  }.freeze

  def setup
    NetworkGuard.reached = 0
    NetworkGuard.armed = true
  end

  def teardown
    NetworkGuard.armed = false
  end

  def data(entity)
    Likeness::Joplin.data(entity)
  end

  def test_the_offline_cycle_seed_list_load_create_update_with_no_network
    sdk = JoplinSDK.test(Harness.deep_copy(SEED))

    listed = sdk.Note.list({}).map { |e| data(e) }
    assert_equal %w[n1 n2], listed.map { |n| n['id'] }.sort, 'the seeded notes are listed'
    assert_equal 'seeded', data(sdk.Note.load({ 'id' => 'n1' }))['title']

    # EXPLICIT id: one the SDK minted would be unassertable, and shaped
    # differently in every port.
    made = data(sdk.Note.create({ 'id' => 'n3', 'title' => 'made here', 'parent_id' => 'f1' }))
    assert_equal 'n3', made['id'], 'the explicit identifier is the one that is kept'
    assert_equal 3, sdk.Note.list({}).length, 'the created note is visible to a subsequent list'

    assert_equal 'renamed', data(sdk.Note.update({ 'id' => 'n3', 'title' => 'renamed' }))['title']
    assert_equal 'renamed', data(sdk.Note.load({ 'id' => 'n3' }))['title'], 'the update is visible to a subsequent load'

    assert_equal 0, NetworkGuard.reached, 'no real network call was attempted'
  end

  # A guard on the guard: without it the test above proves nothing about the network.
  def test_the_blocker_itself_works
    assert_raises(RuntimeError) { Net::HTTP.new('127.0.0.1', 1).start }
    assert_equal 1, NetworkGuard.reached
  end
end
