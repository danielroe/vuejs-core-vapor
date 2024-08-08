import { type ShallowRef, readonly, shallowRef } from '@vue/reactivity'
import { getCurrentInstance } from '../component'
import { warn } from '../warning'
import { EMPTY_OBJ } from '@vue/shared'

export function useTemplateRef<T = unknown>(
  key: string,
): Readonly<ShallowRef<T | null>> {
  const i = getCurrentInstance()
  const r = shallowRef(null)
  if (i) {
    const refs = i.refs === EMPTY_OBJ ? (i.refs = {}) : i.refs
    Object.defineProperty(refs, key, {
      enumerable: true,
      get: () => r.value,
      set: val => (r.value = val),
    })
  } else if (__DEV__) {
    warn(
      `useTemplateRef() is called when there is no active component ` +
        `instance to be associated with.`,
    )
  }
  return (__DEV__ ? readonly(r) : r) as any
}
