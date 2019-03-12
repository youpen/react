/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */


// 数字越大，优先级越高
// 这种计算模块，如果不理解，尝试用测试数值进行输入，分析输出结果
import MAX_SIGNED_31_BIT_INT from './maxSigned31BitInt';

export type ExpirationTime = number;

export const NoWork = 0;
export const Never = 1;
export const Sync = MAX_SIGNED_31_BIT_INT;

const UNIT_SIZE = 10;
const MAGIC_NUMBER_OFFSET = MAX_SIGNED_31_BIT_INT - 1;

// 1 unit of expiration time represents 10ms.
export function msToExpirationTime(ms: number): ExpirationTime {
  // Always add an offset so that we don't clash with the magic number for NoWork.
  return MAGIC_NUMBER_OFFSET - ((ms / UNIT_SIZE) | 0);
}

export function expirationTimeToMs(expirationTime: ExpirationTime): number {
  return (MAGIC_NUMBER_OFFSET - expirationTime) * UNIT_SIZE;
}

// precision的可能值是 LOW_PRIORITY_BATCH_SIZE -> 25，HIGH_PRIORITY_BATCH_SIZE -> 10
function ceiling(num: number, precision: number): number {
  return (((num / precision) | 0) + 1) * precision;
  // 假设这里没有 | 0取整
  // 则相当于 num + precision
  // 效果应该和ceiling(num/precision)一样, 唯一的区别就是当num可以被precision整除的时候，没有多添加1个precision

  // 保证计算值最小的差是25
  // 比如， 26、27、28...49都算作50
  // 50、51、52、53、、、73、74都算作75
  // 于Math.ceil的效果区别是，要多加一个precision，当整除时，得到50、75、100等，得到的结果是这样50-> 75 , 75 -> 100, 100 -> 125

  // 目前就是为了让两个相近的更新任务拥有相同的expirationTime，用于batchedUpdates（例如连续调用了多个setState的情况）
  // 令这些batchUpdates在同一次更新中一起完成
}

function computeExpirationBucket(
  currentTime,
  expirationInMs,
  bucketSizeMs,
): ExpirationTime {
  return (
    MAGIC_NUMBER_OFFSET -

    ceiling(
      MAGIC_NUMBER_OFFSET - currentTime + expirationInMs / UNIT_SIZE,
      bucketSizeMs / UNIT_SIZE, // XXX_PRIORITY_BATCH_SIZE / 10
    )
  );
}



export const LOW_PRIORITY_EXPIRATION = 5000;
export const LOW_PRIORITY_BATCH_SIZE = 250;

// 得到较小的数值，对应普通的异步任务
export function computeAsyncExpiration(
  currentTime: ExpirationTime,
): ExpirationTime {
  return computeExpirationBucket(
    currentTime,
    LOW_PRIORITY_EXPIRATION,
    LOW_PRIORITY_BATCH_SIZE,
  );
}

// We intentionally set a higher expiration time for interactive updates in
// dev than in production.
//
// If the main thread is being blocked so long that you hit the expiration,
// it's a problem that could be solved with better scheduling.
//
// People will be more likely to notice this and fix it with the long
// expiration time in development.
//
// In production we opt for better UX at the risk of masking scheduling
// problems, by expiring fast.
export const HIGH_PRIORITY_EXPIRATION = __DEV__ ? 500 : 150;
export const HIGH_PRIORITY_BATCH_SIZE = 100;

// 得到较大的数值，对应用户交互产生的任务，优先级相对较高
export function computeInteractiveExpiration(currentTime: ExpirationTime) {
  return computeExpirationBucket(
    currentTime,
    HIGH_PRIORITY_EXPIRATION,
    HIGH_PRIORITY_BATCH_SIZE,
  );
}
