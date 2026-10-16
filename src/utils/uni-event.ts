/**
 * uni-app 事件对象的小工具
 * ---------------------------------------------------------------------------
 * 为什么需要它：
 *   vue-tsc 会把模板里的 `<input>` 当成 **DOM 的** HTMLInputElement 来做类型检查
 *   （@dcloudio/types 并没有给 Vue 注册小程序组件的 IntrinsicElements），
 *   于是 `@input` 的签名被当成 `(e: Event) => void`。
 *   但 uni-app 实际传进来的是 `{ detail: { value } }` —— 两边对不上，编译就报错。
 *
 * 解决办法：让处理函数的形参写成 `Event`（满足类型检查），
 * 取值统一走下面这个函数，把「平台实际给的是什么」这件事收在一处。
 * 这样页面里就不会到处出现 `as unknown as` 了。
 */

/** uni-app 的 input / textarea / picker 等组件事件的实际形态 */
export interface UniDetailEvent<T = string> {
  detail: {
    value: T;
  };
}

/** 从 input / textarea 事件里取值；拿不到就返回空串，绝不抛异常 */
export function inputValue(e: Event | UniDetailEvent): string {
  const detail = (e as UniDetailEvent).detail;
  if (detail && typeof detail.value === 'string') {
    return detail.value;
  }
  return '';
}

/** 从 multiSelector picker 的 change 事件里取索引数组 */
export function pickerIndexes(e: Event | UniDetailEvent<number[]>): number[] {
  const detail = (e as UniDetailEvent<number[]>).detail;
  if (detail && Array.isArray(detail.value)) {
    return detail.value;
  }
  return [0, 0, 0];
}

/** 从 multiSelector picker 的 columnchange 事件里取「哪一列、滚到第几项」 */
export function pickerColumn(e: Event | { detail: { column: number; value: number } }): {
  column: number;
  value: number;
} {
  const detail = (e as { detail: { column?: number; value?: number } }).detail;
  return {
    column: typeof detail?.column === 'number' ? detail.column : 0,
    value: typeof detail?.value === 'number' ? detail.value : 0
  };
}
