import {
  type CodegenOptions as BaseCodegenOptions,
  type BaseCodegenResult,
  NewlineType,
  type Position,
  type SourceLocation,
  advancePositionWithMutation,
  locStub,
} from '@vue/compiler-dom'
import type { RootIRNode, VaporHelper } from './ir'
import { SourceMapGenerator } from 'source-map-js'
import { extend, isString } from '@vue/shared'
import type { ParserPlugin } from '@babel/parser'
import { genTemplate } from './generators/template'
import { genBlockFunctionContent } from './generators/block'

interface CodegenOptions extends BaseCodegenOptions {
  expressionPlugins?: ParserPlugin[]
}

export type CodeFragment =
  | typeof NEWLINE
  | typeof LF
  | typeof INDENT_START
  | typeof INDENT_END
  | string
  | [code: string, newlineIndex?: number, loc?: SourceLocation, name?: string]
  | undefined

export class CodegenContext {
  options: Required<CodegenOptions>

  code: CodeFragment[]
  map?: SourceMapGenerator

  push: (...args: CodeFragment[]) => void
  multi = (
    [left, right, seg]: [left: string, right: string, segment: string],
    ...fns: Array<false | string | CodeFragment[]>
  ): CodeFragment[] => {
    const frag: CodeFragment[] = []
    fns = fns.filter(Boolean)
    frag.push(left)
    for (let [i, fn] of fns.entries()) {
      if (fn) {
        if (isString(fn)) fn = [fn]
        frag.push(...fn)
        if (i < fns.length - 1) frag.push(seg)
      }
    }
    frag.push(right)
    return frag
  }
  call = (
    name: string,
    ...args: Array<false | string | CodeFragment[]>
  ): CodeFragment[] => {
    return [name, ...this.multi(['(', ')', ', '], ...args)]
  }

  helpers = new Set<string>([])
  vaporHelpers = new Set<string>([])
  helper = (name: string) => {
    this.helpers.add(name)
    return `_${name}`
  }
  vaporHelper = (name: VaporHelper) => {
    this.vaporHelpers.add(name)
    return `_${name}`
  }

  identifiers: Record<string, number> = Object.create(null)
  withId = <T>(fn: () => T, ids: string[]): T => {
    const { identifiers } = this
    for (const id of ids) {
      if (identifiers[id] === undefined) identifiers[id] = 0
      identifiers[id]!++
    }

    const ret = fn()
    ids.forEach(id => identifiers[id]!--)

    return ret
  }

  constructor(
    public ir: RootIRNode,
    options: CodegenOptions,
  ) {
    const defaultOptions = {
      mode: 'function',
      prefixIdentifiers: options.mode === 'module',
      sourceMap: false,
      filename: `template.vue.html`,
      scopeId: null,
      optimizeImports: false,
      runtimeGlobalName: `Vue`,
      runtimeModuleName: `vue`,
      ssrRuntimeModuleName: 'vue/server-renderer',
      ssr: false,
      isTS: false,
      inSSR: false,
      inline: false,
      bindingMetadata: {},
      expressionPlugins: [],
    }
    this.options = extend(defaultOptions, options)

    const [code, push] = buildCodeFragment()
    this.code = code
    this.push = push

    const {
      options: { filename, sourceMap },
    } = this
    if (!__BROWSER__ && sourceMap) {
      // lazy require source-map implementation, only in non-browser builds
      this.map = new SourceMapGenerator()
      this.map.setSourceContent(filename, ir.source)
      this.map._sources.add(filename)
    }
  }
}

export interface VaporCodegenResult extends BaseCodegenResult {
  ast: RootIRNode
  helpers: Set<string>
  vaporHelpers: Set<string>
}

export const NEWLINE = Symbol(__DEV__ ? `newline` : ``)
/** increase offset but don't push actual code */
export const LF = Symbol(__DEV__ ? `line feed` : ``)
export const INDENT_START = Symbol(__DEV__ ? `indent start` : ``)
export const INDENT_END = Symbol(__DEV__ ? `indent end` : ``)

// IR -> JS codegen
export function generate(
  ir: RootIRNode,
  options: CodegenOptions = {},
): VaporCodegenResult {
  const context = new CodegenContext(ir, options)
  const { push, helpers, vaporHelpers } = context

  const functionName = 'render'
  const isSetupInlined = !!options.inline
  if (isSetupInlined) {
    push(`(() => {`)
  } else {
    push(NEWLINE, `export function ${functionName}(_ctx) {`)
  }

  push(INDENT_START)
  ir.template.forEach((template, i) =>
    push(...genTemplate(template, i, context)),
  )
  push(...genBlockFunctionContent(ir, context))
  push(INDENT_END, NEWLINE)

  if (isSetupInlined) {
    push('})()')
  } else {
    push('}')
  }

  const preamble = genHelperImports(context)
  let codegen = genCodeFragment(context)

  if (!isSetupInlined) {
    codegen = preamble + codegen
  }

  return {
    code: codegen,
    ast: ir,
    preamble,
    map: context.map ? context.map.toJSON() : undefined,
    helpers,
    vaporHelpers,
  }
}

function genCodeFragment(context: CodegenContext) {
  let codegen = ''
  const pos = { line: 1, column: 1, offset: 0 }
  let indentLevel = 0

  for (let frag of context.code) {
    if (!frag) continue

    if (frag === NEWLINE) {
      frag = [`\n${`  `.repeat(indentLevel)}`, NewlineType.Start]
    } else if (frag === INDENT_START) {
      indentLevel++
      continue
    } else if (frag === INDENT_END) {
      indentLevel--
      continue
    } else if (frag === LF) {
      pos.line++
      pos.column = 0
      pos.offset++
      continue
    }

    if (isString(frag)) frag = [frag]

    let [code, newlineIndex = NewlineType.None, loc, name] = frag
    codegen += code

    if (!__BROWSER__ && context.map) {
      if (loc) addMapping(loc.start, name)
      if (newlineIndex === NewlineType.Unknown) {
        // multiple newlines, full iteration
        advancePositionWithMutation(pos, code)
      } else {
        // fast paths
        pos.offset += code.length
        if (newlineIndex === NewlineType.None) {
          // no newlines; fast path to avoid newline detection
          if (__TEST__ && code.includes('\n')) {
            throw new Error(
              `CodegenContext.push() called newlineIndex: none, but contains` +
                `newlines: ${code.replace(/\n/g, '\\n')}`,
            )
          }
          pos.column += code.length
        } else {
          // single newline at known index
          if (newlineIndex === NewlineType.End) {
            newlineIndex = code.length - 1
          }
          if (
            __TEST__ &&
            (code.charAt(newlineIndex) !== '\n' ||
              code.slice(0, newlineIndex).includes('\n') ||
              code.slice(newlineIndex + 1).includes('\n'))
          ) {
            throw new Error(
              `CodegenContext.push() called with newlineIndex: ${newlineIndex} ` +
                `but does not conform: ${code.replace(/\n/g, '\\n')}`,
            )
          }
          pos.line++
          pos.column = code.length - newlineIndex
        }
      }
      if (loc && loc !== locStub) {
        addMapping(loc.end)
      }
    }
  }

  return codegen

  function addMapping(loc: Position, name: string | null = null) {
    // we use the private property to directly add the mapping
    // because the addMapping() implementation in source-map-js has a bunch of
    // unnecessary arg and validation checks that are pure overhead in our case.
    const { _names, _mappings } = context.map!
    if (name !== null && !_names.has(name)) _names.add(name)
    _mappings.add({
      originalLine: loc.line,
      originalColumn: loc.column - 1, // source-map column is 0 based
      generatedLine: pos.line,
      generatedColumn: pos.column - 1,
      source: context.options.filename,
      // @ts-expect-error it is possible to be null
      name,
    })
  }
}

export function buildCodeFragment(...frag: CodeFragment[]) {
  const push = frag.push.bind(frag)
  return [frag, push] as const
}

function genHelperImports({ helpers, vaporHelpers, code }: CodegenContext) {
  let imports = ''
  if (helpers.size) {
    code.unshift(LF)
    imports += `import { ${[...helpers]
      .map(h => `${h} as _${h}`)
      .join(', ')} } from 'vue';\n`
  }
  if (vaporHelpers.size) {
    code.unshift(LF)
    imports += `import { ${[...vaporHelpers]
      .map(h => `${h} as _${h}`)
      .join(', ')} } from 'vue/vapor';\n`
  }
  return imports
}
