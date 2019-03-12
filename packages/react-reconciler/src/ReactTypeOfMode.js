/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export type TypeOfMode = number;

// 二进制数字，为什么这样写？方便使用位运算？
// 性能考虑？
export const NoContext = 0b000;
export const ConcurrentMode = 0b001;
export const StrictMode = 0b010;
export const ProfileMode = 0b100;
