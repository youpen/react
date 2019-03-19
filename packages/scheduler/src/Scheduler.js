/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-var */

import {enableSchedulerDebugging} from './SchedulerFeatureFlags';

// TODO: Use symbols?
var ImmediatePriority = 1;
var UserBlockingPriority = 2;
var NormalPriority = 3;
var LowPriority = 4;
var IdlePriority = 5;

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Times out immediately
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
// Eventually times out
var USER_BLOCKING_PRIORITY = 250;
var NORMAL_PRIORITY_TIMEOUT = 5000;
var LOW_PRIORITY_TIMEOUT = 10000;
// Never times out
var IDLE_PRIORITY = maxSigned31BitInt;

// Callbacks are stored as a circular, doubly linked list.
var firstCallbackNode = null;

var currentDidTimeout = false;
// Pausing the scheduler is useful for debugging.
var isSchedulerPaused = false;

var currentPriorityLevel = NormalPriority;
var currentEventStartTime = -1;
var currentExpirationTime = -1;

// This is set when a callback is being executed, to prevent re-entrancy.
var isExecutingCallback = false;

var isHostCallbackScheduled = false;

var hasNativePerformanceNow =
  typeof performance === 'object' && typeof performance.now === 'function';

function ensureHostCallbackIsScheduled() {
  // 当某个callback已经被调用，直接返回不操作（因为调用时会执行类似的本函数的一些操作？
  // 这个属性在flushWork中设置为true
  if (isExecutingCallback) {
    // Don't schedule work yet; wait until the next time we yield.
    return;
  }
  // Schedule the host callback using the earliest expiration in the list.
  var expirationTime = firstCallbackNode.expirationTime;
  if (!isHostCallbackScheduled) {
    isHostCallbackScheduled = true;
  } else {
    // Cancel the existing host callback.
    cancelHostCallback();
  }
  requestHostCallback(flushWork, expirationTime);
}

function flushFirstCallback() {
  var flushedNode = firstCallbackNode;

  // Remove the node from the list before calling the callback. That way the
  // list is in a consistent state even if the callback throws.
  var next = firstCallbackNode.next;
  // 这里是从链表中删除firstCallbackNode的处理
  if (firstCallbackNode === next) {
    // 这种情况，链表只有一个元素，直接清空
    // This is the last callback in the list.
    firstCallbackNode = null;
    next = null;
  } else {
    // 这个操作就是从链表中删除掉firstCallbackNode
    var lastCallbackNode = firstCallbackNode.previous;
    firstCallbackNode = lastCallbackNode.next = next;
    next.previous = lastCallbackNode;
  }

  flushedNode.next = flushedNode.previous = null;

  // Now it's safe to call the callback.
  // 像下面这种，先将currentXXX赋值给previousXXX，然后再讲previousXXX赋值给currentXXX，可能是因为同时还有别的地方需要使用到currentXXX，留意一下
  // 也有可能是要保证代码执行成功之后，才修改currentXXX的值
  var callback = flushedNode.callback;
  var expirationTime = flushedNode.expirationTime;
  var priorityLevel = flushedNode.priorityLevel;
  var previousPriorityLevel = currentPriorityLevel;
  var previousExpirationTime = currentExpirationTime;
  currentPriorityLevel = priorityLevel;
  currentExpirationTime = expirationTime;
  var continuationCallback;
  try {
    continuationCallback = callback();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentExpirationTime = previousExpirationTime;
  }

  // A callback may return a continuation. The continuation should be scheduled
  // with the same priority and expiration as the just-finished callback.
  if (typeof continuationCallback === 'function') {
    var continuationNode: CallbackNode = {
      callback: continuationCallback,
      priorityLevel,
      expirationTime,
      next: null,
      previous: null,
    };

    // Insert the new callback into the list, sorted by its expiration. This is
    // almost the same as the code in `scheduleCallback`, except the callback
    // is inserted into the list *before* callbacks of equal expiration instead
    // of after.
    // 这个链表插入顺序的区别在于，遇到expirationTime相等的element，scheduleCallback会设置在该element后面
    // 而此函数会设置在该element前面
    if (firstCallbackNode === null) {
      // This is the first callback in the list.
      firstCallbackNode = continuationNode.next = continuationNode.previous = continuationNode;
    } else {
      var nextAfterContinuation = null;
      var node = firstCallbackNode;
      do {
        // 和scheduleCallback唯一的区别就是这个等号
        if (node.expirationTime >= expirationTime) {
          // This callback expires at or after the continuation. We will insert
          // the continuation *before* this callback.
          nextAfterContinuation = node;
          break;
        }
        node = node.next;
      } while (node !== firstCallbackNode);

      if (nextAfterContinuation === null) {
        // No equal or lower priority callback was found, which means the new
        // callback is the lowest priority callback in the list.
        nextAfterContinuation = firstCallbackNode;
      } else if (nextAfterContinuation === firstCallbackNode) {
        // The new callback is the highest priority callback in the list.
        firstCallbackNode = continuationNode;
        ensureHostCallbackIsScheduled();
      }

      var previous = nextAfterContinuation.previous;
      previous.next = nextAfterContinuation.previous = continuationNode;
      continuationNode.next = nextAfterContinuation;
      continuationNode.previous = previous;
    }
  }
}

function flushImmediateWork() {
  if (
    // Confirm we've exited the outer most event handler
    // 以目前的代码来看firstCallbackNode.priorityLevel都是默认值，normalPriority，所以这个函数目前还没有用
    currentEventStartTime === -1 &&
    firstCallbackNode !== null &&
    firstCallbackNode.priorityLevel === ImmediatePriority
  ) {
    isExecutingCallback = true;
    try {
      do {
        flushFirstCallback();
      } while (
        // Keep flushing until there are no more immediate callbacks
        firstCallbackNode !== null &&
        firstCallbackNode.priorityLevel === ImmediatePriority
      );
    } finally {
      isExecutingCallback = false;
      if (firstCallbackNode !== null) {
        // There's still work remaining. Request another callback.
        ensureHostCallbackIsScheduled();
      } else {
        isHostCallbackScheduled = false;
      }
    }
  }
}

function flushWork(didTimeout) {
  // didTimeout是指任务是否超时
  // Exit right away if we're currently paused

  if (enableSchedulerDebugging && isSchedulerPaused) {
    return;
  }

  isExecutingCallback = true;
  const previousDidTimeout = currentDidTimeout;
  currentDidTimeout = didTimeout;
  try {
    if (didTimeout) {
      // Flush all the expired callbacks without yielding.
      while (
        firstCallbackNode !== null &&
        !(enableSchedulerDebugging && isSchedulerPaused)
      ) {
        // TODO Wrap in feature flag
        // Read the current time. Flush all the callbacks that expire at or
        // earlier than that time. Then read the current time again and repeat.
        // This optimizes for as few performance.now calls as possible.
        var currentTime = getCurrentTime();
        if (firstCallbackNode.expirationTime <= currentTime) {
          // 这个循环的意思是，遍历callbackNode链表，直到第一个没有过期的callback
          // 所以主要意义就是将所有过期的callback立刻执行完
          do {
            // 这个函数有将callbackNode剥离链表并执行的功能， firstCallbackNode在调用之后会修改成为新值
            // 这里遍历直到第一个没有过期的callback
            flushFirstCallback();
          } while (
            firstCallbackNode !== null &&
            firstCallbackNode.expirationTime <= currentTime &&
            !(enableSchedulerDebugging && isSchedulerPaused)
          );
          continue;
        }
        break;
      }
    } else {
      // Keep flushing callbacks until we run out of time in the frame.
      if (firstCallbackNode !== null) {
        do {
          if (enableSchedulerDebugging && isSchedulerPaused) {
            break;
          }
          flushFirstCallback();
          // shouldYieldToHost就是比较frameDeadline和currentTime，就是当前帧还有时间的话，就一直执行
        } while (firstCallbackNode !== null && !shouldYieldToHost());
      }
    }
  } finally {
    isExecutingCallback = false;
    currentDidTimeout = previousDidTimeout;
    if (firstCallbackNode !== null) {
      // There's still work remaining. Request another callback.
      // callback链表还没全部执行完，继续
      // ensureHostCallbackIsScheduled也是会启动下一帧，所以不是连续调用
      // 同时，isHostCallbackScheduled决定了ensureHostCallbackIsScheduled的行为，
      // 在此分支中isHostCallbackScheduled === true, 所以ensureHostCallbackIsScheduled会执行一个cancelHostCallback函数
      // cancelHostCallback设置scheduledHostCallback为null，可以令上一个animationTick停止
      ensureHostCallbackIsScheduled();
    } else {
      // isHostCallbackScheduled这个变量只会在ensureHostCallbackIsScheduled中被设置为true
      // 这个变量的意义可能是代表，是否所有任务都被flush了？，因为只有firstCallbackNode === null的情况下才会设为false
      isHostCallbackScheduled = false;
    }
    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_runWithPriority(priorityLevel, eventHandler) {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  var previousEventStartTime = currentEventStartTime;
  currentPriorityLevel = priorityLevel;
  currentEventStartTime = getCurrentTime();

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentEventStartTime = previousEventStartTime;

    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_next(eventHandler) {
  let priorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      // Shift down to normal priority
      priorityLevel = NormalPriority;
      break;
    default:
      // Anything lower than normal priority should remain at the current level.
      priorityLevel = currentPriorityLevel;
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;
  var previousEventStartTime = currentEventStartTime;
  currentPriorityLevel = priorityLevel;
  currentEventStartTime = getCurrentTime();

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentEventStartTime = previousEventStartTime;

    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_wrapCallback(callback) {
  var parentPriorityLevel = currentPriorityLevel;
  return function() {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    var previousEventStartTime = currentEventStartTime;
    currentPriorityLevel = parentPriorityLevel;
    currentEventStartTime = getCurrentTime();

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
      currentEventStartTime = previousEventStartTime;
      flushImmediateWork();
    }
  };
}

function unstable_scheduleCallback(callback, deprecated_options) {
  // callback是performAsyncWork
  // getCurrentTime就是获取当前时间，也就是reconciler模块用的now
  // currentEventStartTime在这个模块中的其他地方会修改和使用，但是在react-dom中不会用到，先忽略
  var startTime =
    currentEventStartTime !== -1 ? currentEventStartTime : getCurrentTime();

  var expirationTime;
  if (
    typeof deprecated_options === 'object' &&
    deprecated_options !== null &&
    typeof deprecated_options.timeout === 'number'
  ) {
    // FIXME: Remove this branch once we lift expiration times out of React.
    // 从requestWork调用到这里，目前只会走这个分支
    // 目前来看timeout越小，优先级越大
    expirationTime = startTime + deprecated_options.timeout;
  } else {
    switch (currentPriorityLevel) {
      case ImmediatePriority:
        expirationTime = startTime + IMMEDIATE_PRIORITY_TIMEOUT;
        break;
      case UserBlockingPriority:
        expirationTime = startTime + USER_BLOCKING_PRIORITY;
        break;
      case IdlePriority:
        expirationTime = startTime + IDLE_PRIORITY;
        break;
      case LowPriority:
        expirationTime = startTime + LOW_PRIORITY_TIMEOUT;
        break;
      case NormalPriority:
      default:
        expirationTime = startTime + NORMAL_PRIORITY_TIMEOUT;
    }
  }

  var newNode = {
    callback,
    priorityLevel: currentPriorityLevel, // 这个值暂时用不到，先不看
    expirationTime,
    next: null,
    previous: null,
  };

  // 接下来部分就是将newNode插入到链表中，并且按expirationTime从大到小的顺序
  // Insert the new callback into the list, ordered first by expiration, then
  // by insertion. So the new callback is inserted any other callback with
  // equal expiration.
  // firstCallbackNode 是一个双向循环链表的头部，这个链表在此模块（scheduler）模块维护
  // firstCallbackNode === null 代表这个链表为空
  // 以后如果处理链表，也可以这样做
  if (firstCallbackNode === null) {
    // This is the first callback in the list.
    // 给环形链表添加第一个元素
    firstCallbackNode = newNode.next = newNode.previous = newNode;
    ensureHostCallbackIsScheduled();
  } else {
    var next = null;
    var node = firstCallbackNode;
    // 从头部（firstCallbackNode）开始遍历链表，知道
    do {
      // 这个expirationTime是此函数顶部定义的局部变量
      // 走进这个分支，firstCallbackNode已经不是null，说明之前已经把某个任务的callback添加进来了
      // 这里的expirationTime从计算方式来看，数值越大，优先级反而越小
      if (node.expirationTime > expirationTime) { // TODO 这里是不是大小判断反了？将来可能会改动
        // 看下面注释的意思是，进入这个分支代表新的callback优先级更高？
        // The new callback expires before this one.
        next = node; // next这个局部变量就是为了从链表中找出比当前新进入的callback优先级更小的任务
        // 跳出循环
        break;
      }
      node = node.next;
    } while (node !== firstCallbackNode); // 由于是环形链表，这是已经遍历一圈的标记

    // 这里环形链表的排序是这样的
    /*
    *           head
    *    next7         next1
    *  next6              next2
    *    next5         next3
    *           next4
    *
    * 其中head的expirationTime最小，next7最大，其余的next的expirationTime从小到大排序，
    * 当next === null,走分支1，newNode的expirationTime是最大的（链表每个element都小于newNode），所以需要将newNode插入head之前
    * 当next === firstCallbackNode，newNode的expirationTime是最小的，也就是newNode要插入head之前，成为新的head，
    * 所以分支2需要修改链表的head指针
    * */
    if (next === null) {
      // 分支1
      // No callback with a later expiration was found, which means the new
      // callback has the latest expiration in the list.
      next = firstCallbackNode;
    } else if (next === firstCallbackNode) {
      // 分支2
      // 这个分支是指新的callback的expirationTime最小，那么应该放在头部，这里直接改变头部（firstCallbackNode）指向newNode
      // 后面插入操作正常执行，与上面的判断分支类似
      // The new callback has the earliest expiration in the entire list.
      firstCallbackNode = newNode;
      ensureHostCallbackIsScheduled();
    }
    // 环形双向链表插入的常规操作，这里是指在next节点之前插入newNode
    var previous = next.previous;
    previous.next = next.previous = newNode;
    newNode.next = next;
    newNode.previous = previous;
  }

  return newNode;
}

function unstable_pauseExecution() {
  isSchedulerPaused = true;
}

function unstable_continueExecution() {
  isSchedulerPaused = false;
  if (firstCallbackNode !== null) {
    ensureHostCallbackIsScheduled();
  }
}

function unstable_getFirstCallbackNode() {
  return firstCallbackNode;
}

function unstable_cancelCallback(callbackNode) {
  var next = callbackNode.next;
  if (next === null) {
    // Already cancelled.
    return;
  }

  if (next === callbackNode) {
    // This is the only scheduled callback. Clear the list.
    firstCallbackNode = null;
  } else {
    // Remove the callback from its position in the list.
    if (callbackNode === firstCallbackNode) {
      firstCallbackNode = next;
    }
    var previous = callbackNode.previous;
    previous.next = next;
    next.previous = previous;
  }

  callbackNode.next = callbackNode.previous = null;
}

function unstable_getCurrentPriorityLevel() {
  return currentPriorityLevel;
}

function unstable_shouldYield() {
  return (
    // currentDidTimeout表示没有callback超时
    // shouldYieldToHost表示当前帧是否还有剩余时间

    // 关于firstCallbackNode.expirationTime < currentExpirationTime
    // firstCallbackNode是在scheduleCallback中被修改，也就是用户可能操作触发新任务的时候修改
    // 而currentExpirationTime是当前正在执行的callback(performAsyncWork)的expirationTime，在flushFirstCallback中被修改
    // 而从firstCallbackNode到执行flushFirstCallback的过程中，使用了MessageChannel让出线程
    // 所以在这段时间用户操作可能出现新任务，导致firstCallbackNode.expirationTime !== currentExpirationTime
    // 所以这里是判断是否有新任务进来，并且新任务的优先级更高？

    // 这个函数会在接下来的各个流程中用到，每次调用这个函数就是检查是否有新任务，考虑是否需要中止
    // TODO 整理中断位置、scheduleCallback、performWork、performWorkOnRoot、renderRoot
    !currentDidTimeout &&
    ((firstCallbackNode.expirationTime < currentExpirationTime) ||
      shouldYieldToHost())
  );
}

// The remaining code is essentially a polyfill for requestIdleCallback. It
// works by scheduling a requestAnimationFrame, storing the time for the start
// of the frame, then scheduling a postMessage which gets scheduled after paint.
// Within the postMessage handler do as much work as possible until time + frame
// rate. By separating the idle call into a separate event tick we ensure that
// layout, paint and other browser work is counted against the available time.
// The frame rate is dynamically adjusted.

// We capture a local reference to any global, in case it gets polyfilled after
// this module is initially evaluated. We want to be using a
// consistent implementation.
var localDate = Date;

// This initialization code may run even on server environments if a component
// just imports ReactDOM (e.g. for findDOMNode). Some environments might not
// have setTimeout or clearTimeout. However, we always expect them to be defined
// on the client. https://github.com/facebook/react/pull/13088
var localSetTimeout = typeof setTimeout === 'function' ? setTimeout : undefined;
var localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : undefined;

// We don't expect either of these to necessarily be defined, but we will error
// later if they are missing on the client.
var localRequestAnimationFrame =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : undefined;
var localCancelAnimationFrame =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined;

var getCurrentTime;

// requestAnimationFrame does not run when the tab is in the background. If
// we're backgrounded we prefer for that work to happen so that the page
// continues to load in the background. So we also schedule a 'setTimeout' as
// a fallback.
// TODO: Need a better heuristic for backgrounded work.
var ANIMATION_FRAME_TIMEOUT = 100;
var rAFID;
var rAFTimeoutID;
// 一个比较独立的函数
var requestAnimationFrameWithTimeout = function(callback) {
  // callback就是animationTick方法
  // schedule rAF and also a setTimeout
  // localRequestAnimationFrame相当于window.requestAnimationFrame
  // 接下来两个调用时超时并发处理
  // 1. 调用requestAnimationFrame
  rAFID = localRequestAnimationFrame(function(timestamp) {
    // cancel the setTimeout
    localClearTimeout(rAFTimeoutID);
    callback(timestamp);
  });
  // 2. 调用setTimeout，时间为ANIMATION_FRAME_TIMEOUT（100),超时则取消rAF，改为直接调用
  rAFTimeoutID = localSetTimeout(function() {
    // cancel the requestAnimationFrame
    localCancelAnimationFrame(rAFID);
    callback(getCurrentTime());
  }, ANIMATION_FRAME_TIMEOUT);
};

if (hasNativePerformanceNow) {
  var Performance = performance;
  getCurrentTime = function() {
    return Performance.now();
  };
} else {
  getCurrentTime = function() {
    return localDate.now();
  };
}

var requestHostCallback;
var cancelHostCallback;
var shouldYieldToHost;

var globalValue = null;
if (typeof window !== 'undefined') {
  globalValue = window;
} else if (typeof global !== 'undefined') {
  globalValue = global;
}

// _schedMock是测试用，先不理
if (globalValue && globalValue._schedMock) {
  // Dynamic injection, only for testing purposes.
  var globalImpl = globalValue._schedMock;
  requestHostCallback = globalImpl[0];
  cancelHostCallback = globalImpl[1];
  shouldYieldToHost = globalImpl[2];
  getCurrentTime = globalImpl[3];
} else if (
  // If Scheduler runs in a non-DOM environment, it falls back to a naive
  // implementation using setTimeout.
  typeof window === 'undefined' ||
  // Check if MessageChannel is supported, too.
  typeof MessageChannel !== 'function'
) {
  // If this accidentally gets imported in a non-browser environment, e.g. JavaScriptCore,
  // fallback to a naive implementation.
  var _callback = null;
  var _flushCallback = function(didTimeout) {
    if (_callback !== null) {
      try {
        _callback(didTimeout);
      } finally {
        _callback = null;
      }
    }
  };
  requestHostCallback = function(cb, ms) {
    if (_callback !== null) {
      // Protect against re-entrancy.
      setTimeout(requestHostCallback, 0, cb);
    } else {
      _callback = cb;
      setTimeout(_flushCallback, 0, false);
    }
  };
  cancelHostCallback = function() {
    _callback = null;
  };
  shouldYieldToHost = function() {
    return false;
  };
} else {
  if (typeof console !== 'undefined') {
    // TODO: Remove fb.me link
    if (typeof localRequestAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support requestAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
    if (typeof localCancelAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support cancelAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
  }

  var scheduledHostCallback = null;
  var isMessageEventScheduled = false;
  var timeoutTime = -1;

  var isAnimationFrameScheduled = false;

  var isFlushingHostCallback = false;

  var frameDeadline = 0;
  // We start out assuming that we run at 30fps but then the heuristic tracking
  // will adjust this value to a faster fps if we get more frequent animation
  // frames.
  var previousFrameTime = 33;
  var activeFrameTime = 33;

  shouldYieldToHost = function() {
    return frameDeadline <= getCurrentTime();
  };

  // We use the postMessage trick to defer idle work until after the repaint.
  var channel = new MessageChannel();
  var port = channel.port2;
  // TODO 就是旧版代码的idleTick?
  channel.port1.onmessage = function(event) {
    // 设置为false，防止animationTick的竞争关系
    isMessageEventScheduled = false;

    var prevScheduledCallback = scheduledHostCallback;
    var prevTimeoutTime = timeoutTime;
    scheduledHostCallback = null;
    timeoutTime = -1;

    var currentTime = getCurrentTime();

    var didTimeout = false;
    // 说明超过了activeFrameTime的实际（默认值33
    // 说明这一帧没有空闲时间，然后检查任务是否过期，过期的话就设置didTimeout，用于后面强制执行
    if (frameDeadline - currentTime <= 0) {
      // There's no time left in this idle period. Check if the callback has
      // a timeout and whether it's been exceeded.
      // 查看任务是否过期，过期则强行更新
      // timeoutTime就是当时的CurrentTime + timeout
      // timeout是scheduleCallbackWithExpirationTime传进来的
      // 相当于currentTimeStamp + expirationTIme
      if (prevTimeoutTime !== -1 && prevTimeoutTime <= currentTime) {
        // Exceeded the timeout. Invoke the callback even though there's no
        // time left.
        // 这种过期的情况有可能已经掉帧了
        didTimeout = true;
      } else {
        // 没有超时则等待下一帧再执行
        // No timeout.
        // isAnimationFrameScheduled这个变量就是判断是否在逐帧执行animationTick
        // 开始设置animationTick时设置为true，animationTick结束时设置为false
        if (!isAnimationFrameScheduled) {
          // Schedule another animation callback so we retry later.
          isAnimationFrameScheduled = true;
          requestAnimationFrameWithTimeout(animationTick);
        }
        // Exit without invoking the callback.
        // 因为上一个任务没有执行完，设置回原来的值，等animationTick继续处理scheduledHostCallback
        // 流程图见processOn
        scheduledHostCallback = prevScheduledCallback;
        timeoutTime = prevTimeoutTime;
        return;
      }
    }

    if (prevScheduledCallback !== null) {
      // 正在调用callback
      isFlushingHostCallback = true;
      try {
        // 执行的过程
        // 这个callback是flushWork
        prevScheduledCallback(didTimeout);
      } finally {
        isFlushingHostCallback = false;
      }
    }
  };

  // 这里就是模仿requestIdleCallback？让浏览器有时间做自己的reflow？
  var animationTick = function(rafTime) {
    // 如果是通过requestHostCallback调用到这里，scheduledHostCallback应该不会null
    // scheduledHostCallback也就是callback
    if (scheduledHostCallback !== null) {
      // Eagerly schedule the next animation callback at the beginning of the
      // frame. If the scheduler queue is not empty at the end of the frame, it
      // will continue flushing inside that callback. If the queue *is* empty,
      // then it will exit immediately. Posting the callback at the start of the
      // frame ensures it's fired within the earliest possible frame. If we
      // waited until the end of the frame to post the callback, we risk the
      // browser skipping a frame and not firing the callback until the frame
      // after that.
      // 所以这里应该是连续递归调用，直到scheduledHostCallback === null
      // scheduledHostCallback会在messageChannel的port1的回调中设为null
      // 因为requestAnimationFrameWithTimeout会加入event loop,所以这里不是普通递归，而是每一帧执行一次
      // 注意当下一帧执行了animationTick时，之前的animationTick已经计算出了nextFrameTime
      requestAnimationFrameWithTimeout(animationTick);
    } else {
      // No pending work. Exit.
      isAnimationFrameScheduled = false;
      return;
    }
    // 保持浏览器能保持每秒30帧，那么每帧就是33毫秒
    // activeFrameTime在模块顶部定义，初始值为33
    // previousFrameTime的初始值也是33
    // nextFrameTime就是此方法到下一帧之前可以执行多少时间
    // 如果第一次执行，nextFrameTime肯定是很大的，因为frameDeadline为0
    // rafTime是当前时间戳
    // 当第一次执行，nextFrameTime的值是一个包含当前时间戳，很大的值
    // 当不是第一次执行frameDeadline在后面已经赋值为rafTime + activeFrameTime
    // 也就是这个公式为new_rafTime - （old_rafTime + old_activeFrameTime） + new_activeFrameTime
    // 也就是(new_rafTime - old_rafTime) + (new_activeFrameTime - old_activeFrameTime)
    // 当一般情况（也就是不走近分支1）的情况，new_activeFrameTime === old_activeFrameTime
    // 所以nextFrameTime === (new_rafTime - old_rafTime)
    // 也就是两个requestAnimationFrameWithTimeout之间的时间差，即一帧所走过的时间
    // 当走过两帧之后，发现nextFrameTime和nextFrameTime的时间都小于activeFrameTime，则判定当前平台的帧数更高（每帧的时间更短）
    // 则走分支1修改activeFrameTime
    var nextFrameTime = rafTime - frameDeadline + activeFrameTime;
    if (
      nextFrameTime < activeFrameTime &&
      previousFrameTime < activeFrameTime
    ) {
      // TODO 分支1
      if (nextFrameTime < 8) {
        // Defensive coding. We don't support higher frame rates than 120hz.
        // If the calculated frame time gets lower than 8, it is probably a bug.
        nextFrameTime = 8;
      }
      // 这里试探性的设置了activeFrame，因为在某些平台下，每秒的帧数可能更大，例如vr游戏这种情况
      // If one frame goes long, then the next one can be short to catch up.
      // If two frames are short in a row, then that's an indication that we
      // actually have a higher frame rate than what we're currently optimizing.
      // We adjust our heuristic dynamically accordingly. For example, if we're
      // running on 120hz display or 90hz VR display.
      // Take the max of the two in case one of them was an anomaly due to
      // missed frame deadlines.
      // 设置activeFrameTime为previousFrameTime和nextFrameTime中的较大者
      activeFrameTime =
        nextFrameTime < previousFrameTime ? previousFrameTime : nextFrameTime;
    } else {
      previousFrameTime = nextFrameTime;
    }
    frameDeadline = rafTime + activeFrameTime;
    // isMessageEventScheduled的值也是在port1的回调中设置为false
    // isMessageEventScheduled的意义就是每一帧的animationTick是否被执行完
    // animationTick -> port.postMessage(设置isMessageEventScheduled为false) -> animationTick
    // 防止port.postMessage被重复调用（应该是在requestAnimationFrameWithTimeout超时的时候会出现的情况
    // 因为postMessage也是依赖event loop，可能会有竞争关系
    if (!isMessageEventScheduled) {
      isMessageEventScheduled = true;
      // port就是port1
      // postMessage是event loop下一个tick使用，所以就是frameDeadline中，其实留了空闲时间给浏览器执行动画渲染
      // 举个例子： 假设当前浏览器为30帧，则每帧33ms，frameDeadline为currentTime + 33,当调用了port.postMessage,当前tick的js线程就变为空了
      // 这时候就会留给浏览器部分时间做动画渲染，所以实现了requestIdleCallback的功能
      // port.postMessage是留给浏览器渲染时间的关键
      port.postMessage(undefined);
      // 下面是测试requestAnimationFrame和messageChannel的顺序代码
      // var channel = new MessageChannel();
      //
      // channel.port1.onmessage = () => {
      //   console.log('portmessage')
      // }
      //
      // requestAnimationFrame(() => {
      //   console.warn('requestAnimationFrame')
      // })
      // channel.port2.postMessage(undefined)

    }
  };

  requestHostCallback = function(callback, absoluteTimeout) {
    // 也就是firstCallbackNode里的callback
    // scheduledHostCallback就是flushWork
    scheduledHostCallback = callback;
    timeoutTime = absoluteTimeout;
    // 下面的rAF应该就是指requestAnimationFrame
    // isFlushingHostCallback这个判断是一个Eagerly操作，如果有新的任务进来，
    // 尽量让其直接执行，防止浏览器在下一帧才执行这个callback
    if (isFlushingHostCallback || absoluteTimeout < 0) {
      // absoluteTimeout < 0说明任务超时了，立刻执行，不要等下一帧
      // Don't wait for the next frame. Continue working ASAP, in a new event.
      // port就是port1
      port.postMessage(undefined);
    } else if (!isAnimationFrameScheduled) {
      // If rAF didn't already schedule one, we need to schedule a frame.
      // TODO: If this rAF doesn't materialize because the browser throttles, we
      // might want to still have setTimeout trigger rIC as a backup to ensure
      // that we keep performing work.
      isAnimationFrameScheduled = true;
      requestAnimationFrameWithTimeout(animationTick);
    }
  };

  cancelHostCallback = function() {
    scheduledHostCallback = null;
    isMessageEventScheduled = false;
    timeoutTime = -1;
  };
}

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  unstable_shouldYield,
  unstable_continueExecution,
  unstable_pauseExecution,
  unstable_getFirstCallbackNode,
  getCurrentTime as unstable_now,
};
