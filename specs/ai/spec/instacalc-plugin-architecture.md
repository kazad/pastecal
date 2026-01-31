# Instacalc Plugin Architecture Specification

## Overview

This document specifies a plugin-driven architecture for Instacalc where the expression evaluation pipeline is composed of modular, replaceable components. The goal is extensibility without complexity.

## Design Philosophy

1. **Composition over configuration** - Plugins are simple functions, not complex objects with lifecycle hooks
2. **Explicit over magic** - No auto-discovery, no dependency injection, just imports and registration
3. **Minimal core** - The core is a thin orchestration layer; all behavior lives in plugins
4. **Fail fast** - Unknown node types or missing functions throw immediately, not silently

---

## Architecture

### Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            INSTACALC PIPELINE                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Input String                                                          │
│        │                                                                │
│        ▼                                                                │
│   ┌─────────────────────┐                                               │
│   │   PREPROCESSORS     │  ← Plugin Layer 1                             │
│   │   (text → text)     │    - Unit expansion                           │
│   │                     │    - Percentage syntax                        │
│   │   Ordered chain     │    - Variable substitution                    │
│   └─────────────────────┘    - Shorthand expansion                      │
│        │                                                                │
│        ▼                                                                │
│   ┌─────────────────────┐                                               │
│   │      PARSER         │  ← Core (not pluggable)                       │
│   │   (text → AST)      │    - Tokenizer                                │
│   │                     │    - Recursive descent parser                 │
│   │   Single impl       │    - Produces canonical AST                   │
│   └─────────────────────┘                                               │
│        │                                                                │
│        ▼                                                                │
│   ┌─────────────────────┐                                               │
│   │  AST TRANSFORMERS   │  ← Plugin Layer 2 (optional)                  │
│   │   (AST → AST)       │    - Optimization passes                      │
│   │                     │    - Constant folding                         │
│   │   Ordered chain     │    - Macro expansion                          │
│   └─────────────────────┘                                               │
│        │                                                                │
│        ▼                                                                │
│   ┌─────────────────────┐                                               │
│   │    EVALUATORS       │  ← Plugin Layer 3                             │
│   │  (node → value)     │    - Arithmetic operations                    │
│   │                     │    - Function calls                           │
│   │   Type-dispatched   │    - Comparisons, logic                       │
│   └─────────────────────┘                                               │
│        │                                                                │
│        ▼                                                                │
│   ┌─────────────────────┐                                               │
│   │     FUNCTIONS       │  ← Plugin Layer 4                             │
│   │  (args → value)     │    - Math: sin, cos, sqrt                     │
│   │                     │    - Dates: today, addDays                    │
│   │   Name-dispatched   │    - Conversions: toMeters                    │
│   └─────────────────────┘                                               │
│        │                                                                │
│        ▼                                                                │
│      Result                                                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why the Parser is NOT Pluggable

The parser is intentionally **not** part of the plugin system:

1. **AST is the contract** - Plugins depend on a stable AST structure. Multiple parsers would mean multiple AST dialects, breaking evaluator plugins.

2. **Syntax should be consistent** - Users expect `2 + 3` to always parse the same way. Pluggable parsing leads to fragmentation.

3. **Preprocessors handle syntax sugar** - Want new syntax? A preprocessor can transform it to standard syntax before parsing.

4. **Complexity explosion** - Pluggable parsers require a grammar plugin system, precedence negotiation, and conflict resolution. Not worth it.

---

## Plugin Types

### 1. Preprocessors

**Purpose**: Transform input text before parsing. Handle syntax sugar, shortcuts, and domain-specific notation.

**Interface**:
```typescript
type Preprocessor = (input: string, context: Context) => string;
```

**Execution**: Ordered chain. Each preprocessor receives output of the previous one.

**Examples**:
```javascript
// Unit expansion: "5 feet" → "5 * 0.3048"
function unitsPreprocessor(input, ctx) {
  return input
    .replace(/(\d+(?:\.\d+)?)\s*feet/gi, '($1 * 0.3048)')
    .replace(/(\d+(?:\.\d+)?)\s*inches/gi, '($1 * 0.0254)')
    .replace(/(\d+(?:\.\d+)?)\s*miles/gi, '($1 * 1609.34)');
}

// Percentage syntax: "10% of 50" → "50 * 0.10"
function percentPreprocessor(input, ctx) {
  return input.replace(
    /(\d+(?:\.\d+)?)\s*%\s*of\s+(\d+(?:\.\d+)?)/gi,
    '($2 * $1 / 100)'
  );
}

// Variable substitution from context
function variablePreprocessor(input, ctx) {
  for (const [name, value] of Object.entries(ctx.variables || {})) {
    input = input.replace(new RegExp(`\\b${name}\\b`, 'g'), String(value));
  }
  return input;
}
```

**Registration**:
```javascript
registry.preprocessors.set('units', { fn: unitsPreprocessor, priority: 100 });
registry.preprocessors.set('percent', { fn: percentPreprocessor, priority: 200 });
registry.preprocessors.set('variables', { fn: variablePreprocessor, priority: 50 });
// Lower priority = runs first
```

### 2. AST Transformers

**Purpose**: Transform the AST before evaluation. Useful for optimization, macro expansion, or domain-specific rewrites.

**Interface**:
```typescript
type ASTTransformer = (ast: ASTNode, context: Context) => ASTNode;
```

**Execution**: Ordered chain. Each transformer receives output of the previous one.

**Examples**:
```javascript
// Constant folding: (2 + 3) → 5 at AST level
function constantFoldingTransformer(ast, ctx) {
  return walkAST(ast, (node) => {
    if (node.type === 'BinaryOp' &&
        node.left.type === 'Number' &&
        node.right.type === 'Number') {
      // Fold constants
      const result = evaluateOp(node.op, node.left.value, node.right.value);
      return { type: 'Number', value: result };
    }
    return node;
  });
}
```

**Note**: AST transformers are optional and most use cases won't need them. They exist for advanced scenarios like optimization or compile-time computation.

### 3. Evaluators

**Purpose**: Evaluate specific AST node types. This is where computation happens.

**Interface**:
```typescript
type Evaluator = (
  node: ASTNode,
  evaluate: (node: ASTNode) => Value,
  context: Context
) => Value;
```

**Execution**: Type-dispatched. The core evaluator looks up `evaluators[node.type]` and calls it.

**Examples**:
```javascript
// Number literal
evaluators.Number = (node, evaluate, ctx) => {
  return node.value;
};

// Binary operation
evaluators.BinaryOp = (node, evaluate, ctx) => {
  const left = evaluate(node.left);
  const right = evaluate(node.right);

  switch (node.op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/':
      if (right === 0) throw new Error('Division by zero');
      return left / right;
    case '^': return Math.pow(left, right);
    case '%': return left % right;
    default:
      throw new Error(`Unknown operator: ${node.op}`);
  }
};

// Function call
evaluators.FunctionCall = (node, evaluate, ctx) => {
  const fn = ctx.functions[node.name];
  if (!fn) throw new Error(`Unknown function: ${node.name}`);

  const args = node.args.map(arg => evaluate(arg));
  return fn(args, ctx);
};

// Unary operation
evaluators.UnaryOp = (node, evaluate, ctx) => {
  const operand = evaluate(node.operand);
  switch (node.op) {
    case '-': return -operand;
    case '+': return +operand;
    case '!': return !operand;
    default:
      throw new Error(`Unknown unary operator: ${node.op}`);
  }
};
```

### 4. Functions

**Purpose**: Provide callable functions within expressions (e.g., `sin(45)`, `max(1, 2, 3)`).

**Interface**:
```typescript
type CalcFunction = (args: Value[], context: Context) => Value;
```

**Execution**: Name-dispatched via `FunctionCall` evaluator.

**Examples**:
```javascript
// Math functions
functions.sin = (args) => Math.sin(args[0]);
functions.cos = (args) => Math.cos(args[0]);
functions.tan = (args) => Math.tan(args[0]);
functions.sqrt = (args) => Math.sqrt(args[0]);
functions.abs = (args) => Math.abs(args[0]);
functions.round = (args) => Math.round(args[0]);
functions.floor = (args) => Math.floor(args[0]);
functions.ceil = (args) => Math.ceil(args[0]);
functions.log = (args) => Math.log(args[0]);
functions.log10 = (args) => Math.log10(args[0]);
functions.exp = (args) => Math.exp(args[0]);
functions.pow = (args) => Math.pow(args[0], args[1]);

// Aggregates
functions.min = (args) => Math.min(...args);
functions.max = (args) => Math.max(...args);
functions.sum = (args) => args.reduce((a, b) => a + b, 0);
functions.avg = (args) => args.reduce((a, b) => a + b, 0) / args.length;

// Date functions (for calendar integration)
functions.today = (args, ctx) => new Date();
functions.now = (args, ctx) => new Date();
functions.addDays = (args) => {
  const date = new Date(args[0]);
  date.setDate(date.getDate() + args[1]);
  return date;
};

// Conditionals
functions.if = (args) => args[0] ? args[1] : args[2];
```

---

## AST Node Types

The parser produces these canonical node types:

```typescript
type ASTNode =
  | { type: 'Number'; value: number }
  | { type: 'String'; value: string }
  | { type: 'Boolean'; value: boolean }
  | { type: 'Identifier'; name: string }
  | { type: 'BinaryOp'; op: string; left: ASTNode; right: ASTNode }
  | { type: 'UnaryOp'; op: string; operand: ASTNode }
  | { type: 'FunctionCall'; name: string; args: ASTNode[] }
  | { type: 'Assignment'; name: string; value: ASTNode }
  | { type: 'Array'; elements: ASTNode[] }
  | { type: 'Property'; object: ASTNode; property: string }
  | { type: 'Ternary'; condition: ASTNode; consequent: ASTNode; alternate: ASTNode };
```

**Extensibility**: New node types can be added to the parser and corresponding evaluators registered. However, this should be rare—most extensions work via preprocessors or functions.

---

## Registry Design

### Structure

```javascript
const registry = {
  // Ordered by priority (lower = earlier)
  preprocessors: new Map(),   // name → { fn, priority }
  transformers: new Map(),    // name → { fn, priority }

  // Dispatched by type/name
  evaluators: {},             // nodeType → fn
  functions: {},              // fnName → fn
};
```

### Registration API

```javascript
// Register a preprocessor
function registerPreprocessor(name, fn, priority = 100) {
  registry.preprocessors.set(name, { fn, priority });
}

// Register an evaluator
function registerEvaluator(nodeType, fn) {
  if (registry.evaluators[nodeType]) {
    console.warn(`Overwriting evaluator for ${nodeType}`);
  }
  registry.evaluators[nodeType] = fn;
}

// Register a function
function registerFunction(name, fn) {
  registry.functions[name] = fn;
}

// Bulk registration from a plugin module
function registerPlugin(plugin) {
  if (plugin.preprocessors) {
    for (const [name, config] of Object.entries(plugin.preprocessors)) {
      registerPreprocessor(name, config.fn, config.priority);
    }
  }
  if (plugin.evaluators) {
    for (const [type, fn] of Object.entries(plugin.evaluators)) {
      registerEvaluator(type, fn);
    }
  }
  if (plugin.functions) {
    for (const [name, fn] of Object.entries(plugin.functions)) {
      registerFunction(name, fn);
    }
  }
}
```

### Plugin Module Format

```javascript
// plugins/math.js
export default {
  name: 'math',

  functions: {
    sin: (args) => Math.sin(args[0]),
    cos: (args) => Math.cos(args[0]),
    // ...
  }
};

// plugins/units.js
export default {
  name: 'units',

  preprocessors: {
    units: {
      fn: (input) => input.replace(/(\d+)\s*feet/gi, '($1 * 0.3048)'),
      priority: 100
    }
  },

  functions: {
    toFeet: (args) => args[0] / 0.3048,
    toMeters: (args) => args[0] * 0.3048,
  }
};
```

---

## Core Implementation

### Main Entry Point

```javascript
// instacalc.js
import { registry } from './registry.js';
import { parse } from './parser.js';

export function calculate(input, context = {}) {
  // Build execution context
  const ctx = {
    variables: context.variables || {},
    functions: { ...registry.functions },
    ...context
  };

  // 1. Run preprocessors (ordered by priority)
  let text = input;
  const preprocessors = [...registry.preprocessors.values()]
    .sort((a, b) => a.priority - b.priority);

  for (const { fn } of preprocessors) {
    text = fn(text, ctx);
  }

  // 2. Parse to AST
  const ast = parse(text);

  // 3. Run AST transformers (ordered by priority)
  let transformedAST = ast;
  const transformers = [...registry.transformers.values()]
    .sort((a, b) => a.priority - b.priority);

  for (const { fn } of transformers) {
    transformedAST = fn(transformedAST, ctx);
  }

  // 4. Evaluate
  return evaluate(transformedAST, ctx);
}

function evaluate(node, ctx) {
  const evaluator = registry.evaluators[node.type];
  if (!evaluator) {
    throw new Error(`No evaluator registered for node type: ${node.type}`);
  }
  return evaluator(node, (n) => evaluate(n, ctx), ctx);
}
```

### Default Plugin Set

```javascript
// defaults.js - Loaded automatically
import core from './plugins/core.js';       // Number, BinaryOp, UnaryOp, etc.
import math from './plugins/math.js';       // sin, cos, sqrt, etc.
import logic from './plugins/logic.js';     // if, and, or, not
import arrays from './plugins/arrays.js';   // sum, avg, min, max

registerPlugin(core);
registerPlugin(math);
registerPlugin(logic);
registerPlugin(arrays);
```

---

## Pros and Cons Analysis

### Pros

| Advantage | Description |
|-----------|-------------|
| **Extensibility** | New operations, functions, and syntax can be added without modifying core code. Third parties can create plugins. |
| **Separation of Concerns** | Each plugin handles one aspect (math, dates, units). Easy to understand and maintain in isolation. |
| **Testability** | Plugins are pure functions. Unit testing is trivial—pass input, check output. |
| **Opt-in Complexity** | Start with minimal plugins, add more as needed. Don't pay for features you don't use. |
| **Domain Adaptation** | Financial calculations? Add a `finance` plugin. Scientific? Add a `science` plugin. The core doesn't need to know about domains. |
| **Graceful Degradation** | If a plugin fails to load, others still work. Can provide fallbacks or clear error messages. |
| **Code Organization** | Natural file structure. Finding "where is sin() defined?" is trivial. |
| **Hot Reloading Potential** | Plugins can be swapped at runtime without restarting (useful for development). |

### Cons

| Disadvantage | Description |
|--------------|-------------|
| **Indirection** | To understand `2 + 3`, you need to know: preprocessors didn't change it, parser produced a `BinaryOp`, evaluator for `BinaryOp` exists. More jumping around. |
| **Plugin Ordering Bugs** | Preprocessor A might depend on running before/after B. Priority numbers help but don't prevent all issues. |
| **Performance Overhead** | Each plugin call has function call overhead. For tight loops with millions of calculations, this adds up. |
| **Discovery Problem** | "What functions are available?" requires introspecting the registry rather than reading one file. |
| **Inconsistent Behavior Risk** | If plugins can override core evaluators, two Instacalc instances might behave differently. |
| **Debugging Complexity** | Stack traces go through dispatch layers. "Why did `5 feet` become `5 * 0.3048`?" requires understanding the preprocessor chain. |
| **Type Safety Challenges** | Dynamic dispatch makes static analysis harder. TypeScript can't verify all plugins handle all cases. |
| **Documentation Burden** | Each plugin needs documentation. Users need to know which plugins are active to understand available features. |

### Mitigations

| Con | Mitigation |
|-----|------------|
| Indirection | Good error messages that include plugin name: "Error in evaluator 'BinaryOp' from plugin 'core'" |
| Ordering bugs | Explicit dependency declaration (optional): `{ after: ['variables'], before: ['units'] }` |
| Performance | Keep plugin system for user-facing calculations only. If perf-critical, compile to direct calls. |
| Discovery | `instacalc.listFunctions()`, `instacalc.listPreprocessors()` introspection methods |
| Inconsistency | "Standard" plugin bundle that most users should use. Make customization opt-in. |
| Debugging | Debug mode that logs each pipeline stage: input, after each preprocessor, AST, result |
| Type safety | TypeScript generics for node types, runtime validation in development mode |
| Documentation | Auto-generate docs from plugin metadata |

---

## Alternative Approaches Considered

### Alternative 1: Monolithic Evaluator

```javascript
function evaluate(node) {
  switch (node.type) {
    case 'Number': return node.value;
    case 'BinaryOp': // ...
    case 'FunctionCall': // ...
    // 500 more lines...
  }
}
```

**Rejected because**: Not extensible. Adding features requires modifying core. Testing is all-or-nothing.

### Alternative 2: Class-Based Plugins with Lifecycle

```javascript
class MathPlugin extends Plugin {
  onInit() { /* ... */ }
  onDestroy() { /* ... */ }
  onBeforeEvaluate(ast) { /* ... */ }
  onAfterEvaluate(result) { /* ... */ }
  // ...
}
```

**Rejected because**: Over-engineered. Lifecycle hooks add complexity without clear benefit. Most plugins don't need state.

### Alternative 3: Pluggable Parser (Grammar Plugins)

```javascript
parser.addOperator('^', { precedence: 14, associativity: 'right' });
parser.addSyntax('percent', /(\d+)%/, (match) => ({ type: 'Percent', value: match[1] }));
```

**Rejected because**:
- Grammar conflicts are hard to debug
- Multiple AST dialects break evaluator plugins
- Preprocessors handle 90% of syntax sugar needs with 10% of the complexity

### Alternative 4: Visitor Pattern for Evaluation

```javascript
class EvaluatorVisitor {
  visitNumber(node) { return node.value; }
  visitBinaryOp(node) { /* ... */ }
}
```

**Rejected because**: Class-based visitor is more rigid than function-based dispatch. Harder to compose, harder to override single node types.

---

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Parser (recursive descent, not pluggable)
- [ ] Registry with basic registration
- [ ] Evaluator dispatch loop
- [ ] Core plugin (Number, BinaryOp, UnaryOp, FunctionCall)

### Phase 2: Essential Plugins
- [ ] Math plugin (sin, cos, sqrt, pow, etc.)
- [ ] Logic plugin (if, and, or, comparisons)
- [ ] Variable preprocessor

### Phase 3: Extended Features
- [ ] Units preprocessor and functions
- [ ] Percentage syntax preprocessor
- [ ] Date/time functions
- [ ] Array operations

### Phase 4: Developer Experience
- [ ] Debug mode with pipeline logging
- [ ] Introspection API (list functions, etc.)
- [ ] Plugin validation (check all node types covered)
- [ ] Error messages with plugin context

### Phase 5: Integration
- [ ] Calendar integration (dates, recurrence calculations)
- [ ] Multi-line support (spreadsheet-style)
- [ ] Reference between lines (`$1 + $2`)

---

## File Structure

```
public/instacalc/
├── index.js                 # Main entry, exports calculate()
├── parser.js                # Tokenizer + recursive descent parser
├── registry.js              # Plugin registry
├── evaluator.js             # Core dispatch loop
├── context.js               # Execution context management
├── errors.js                # Custom error types
│
├── plugins/
│   ├── core.js              # Number, BinaryOp, UnaryOp, Identifier
│   ├── math.js              # sin, cos, sqrt, pow, log, exp
│   ├── logic.js             # if, and, or, not, comparisons
│   ├── arrays.js            # sum, avg, min, max, count
│   ├── strings.js           # concat, length, upper, lower
│   ├── dates.js             # today, now, addDays, diffDays
│   └── units.js             # Preprocessor + conversion functions
│
├── presets/
│   ├── standard.js          # Default plugin bundle
│   ├── minimal.js           # Just arithmetic
│   └── scientific.js        # Math-heavy preset
│
└── tests/
    ├── parser.test.js
    ├── evaluator.test.js
    └── plugins/
        ├── math.test.js
        └── units.test.js
```

---

## Usage Examples

### Basic Calculation

```javascript
import { calculate } from './instacalc/index.js';

calculate('2 + 3');           // 5
calculate('sin(45) * 2');     // 1.4142...
calculate('5 feet in meters'); // Error: not yet preprocessed
```

### With Units Plugin

```javascript
import { calculate, registerPlugin } from './instacalc/index.js';
import units from './instacalc/plugins/units.js';

registerPlugin(units);

calculate('5 feet');          // 1.524 (meters)
calculate('toFeet(1.524)');   // 5
```

### With Variables

```javascript
calculate('x + y', {
  variables: { x: 10, y: 20 }
}); // 30
```

### Custom Function

```javascript
import { registerFunction } from './instacalc/index.js';

registerFunction('double', (args) => args[0] * 2);

calculate('double(21)');      // 42
```

### Debug Mode

```javascript
calculate('5 feet + 3', { debug: true });
// Logs:
// [preprocessor:variables] "5 feet + 3" → "5 feet + 3"
// [preprocessor:units] "5 feet + 3" → "(5 * 0.3048) + 3"
// [parser] AST: { type: 'BinaryOp', op: '+', ... }
// [evaluator:BinaryOp] evaluating + with left=1.524, right=3
// [result] 4.524
```

---

## Open Questions

1. **Should functions be async?** Some functions (fetching exchange rates, API calls) are inherently async. Options:
   - All functions sync (simple, fast, limiting)
   - All functions async (consistent, but `await` everywhere)
   - Detect and handle both (complex)

2. **Error recovery**: Should `1 + + 2` fail completely or try to recover?

3. **Internationalization**: Should `1.000,50` (European) be supported? Preprocessor or parser?

4. **Implicit multiplication**: Should `2(3)` mean `2 * 3`? `2x` mean `2 * x`?

5. **Unit tracking**: Should `5 feet + 3 meters` work? Requires type system for values.

---

## Conclusion

The plugin-driven architecture provides a good balance between extensibility and simplicity. The key insight is that **preprocessors handle most syntax sugar needs**, allowing the parser to remain simple and stable. Evaluators are the natural extension point for new node types, and functions are the extension point for new operations.

The main risks are debugging complexity and plugin ordering issues, both of which can be mitigated with good tooling and conventions.

Recommendation: **Proceed with this architecture**, starting with Phase 1 (core infrastructure) and validating the design with real use cases before building out extended features.
