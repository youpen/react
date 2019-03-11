/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export type SideEffectTag = number;

// Don't change these two values. They're used by React Dev Tools.
export const NoEffect = /*              */ 0b000000000000;
export const PerformedWork = /*         */ 0b000000000001;

// You can change the rest (and add more).
export const Placement = /*             */ 0b000000000010;
export const Update = /*                */ 0b000000000100;
export const PlacementAndUpdate = /*    */ 0b000000000110;
export const Deletion = /*              */ 0b000000001000;
export const ContentReset = /*          */ 0b000000010000;
export const Callback = /*              */ 0b000000100000;
export const DidCapture = /*            */ 0b000001000000;
export const Ref = /*                   */ 0b000010000000;
export const Snapshot = /*              */ 0b000100000000;
export const Passive = /*               */ 0b001000000000;

// Passive & Update & Callback & Ref & Snapshot
export const LifecycleEffectMask = /*   */ 0b001110100100;

// Union of all host effects
export const HostEffectMask = /*        */ 0b001111111111;

export const Incomplete = /*            */ 0b010000000000;
export const ShouldCapture = /*         */ 0b100000000000;

// // 没有任何副作用
// export const NoEffect = /*              */ 0b00000000000
// // 用来通知在开发者工具这次更新中当前组件有更新
// export const PerformedWork = /*         */ 0b00000000001
//
// // 需要挂载到DOM上
// export const Placement = /*             */ 0b00000000010
// // 需要执行生命周期方法、
// export const Update = /*                */ 0b00000000100
// // 同时拥有`Placemenet`和`Update`副作用
// export const PlacementAndUpdate = /*    */ 0b00000000110
// // 删除节点
// export const Deletion = /*              */ 0b00000001000
// // 更新内容（文字节点？）
// export const ContentReset = /*          */ 0b00000010000
// //
// export const Callback = /*              */ 0b00000100000
// // 有异常被捕获
// export const DidCapture = /*            */ 0b00001000000
// // 有制定ref
// export const Ref = /*                   */ 0b00010000000
// // getSnaphotBeforeUpdate
// export const Snapshot = /*              */ 0b00100000000
//
// export const LifecycleEffectMask = /*   */ 0b00110100100
//
// export const HostEffectMask = /*        */ 0b00111111111
//
// export const Incomplete = /*            */ 0b01000000000
// export const ShouldCapture = /*         */ 0b10000000000
