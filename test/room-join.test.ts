import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoomJoinRequest } from '../server/app.js';

test('accepts a version 2 host room join request', () => {
  assert.equal(validateRoomJoinRequest({
    roomId: 'room-production-check',
    name: 'Host',
    protocolVersion: 2,
    host: true,
    hostCapability: 'capability-production-check',
  }), null);
});

test('rejects unknown room join fields while accepting known protocol fields', () => {
  assert.equal(validateRoomJoinRequest({
    roomId: 'room-production-check',
    name: 'Host',
    protocolVersion: 2,
    host: true,
    hostCapability: 'capability-production-check',
    unexpected: true,
  }), 'Use a room ID of 1–48 letters, numbers, hyphens or underscores and a name of 1–32 characters.');
});
