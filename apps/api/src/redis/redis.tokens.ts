import type { Redis } from 'ioredis';

export type RedisRole = 'subscriber' | 'command';

/** The slice of ioredis the subscriber uses; fakes implement only this. */
export type RedisClient = Pick<
  Redis,
  | 'on'
  | 'connect'
  | 'psubscribe'
  | 'punsubscribe'
  | 'get'
  | 'quit'
  | 'disconnect'
>;

export type RedisFactory = (role: RedisRole) => RedisClient;

export const REDIS_FACTORY = Symbol('REDIS_FACTORY');
