## VDOM Structure Optimization for Diffing

To improve performance and enable efficient reconciliation (diffing) between the old and new Virtual DOM structures, the primary `DOMStruct` definition has been updated from using a linear array of attribute tuples (`Props[]`) to using keyed maps for properties and attributes.

This change ensures $O(1)$ lookup time for properties during the diffing phase, which is crucial for reducing overhead during complex updates.

### New DOMStruct Definition

The `DOMStruct` is now defined as a 6-element readonly tuple:

```typescript
export type DOMStruct<K extends TagName> = readonly [
    tag: K, // 0: The HTML tag name (e.g., 'div', 'span')
    props: PropMap, // 1: JavaScript Properties (e.g., innerText, onclick, style object)
    attrs: AttrMap, // 2: HTML Attributes (e.g., class, id)
    hasRef: boolean, // 3: Flag indicating if the element should be collected by domCreator
    children?: readonly DOMStruct<TagName>[], // 4: Child DOM structures
    key?: string | number // 5: Optional unique key for list reconciliation
];
```

The separation of properties (`props`) and attributes (`attrs`) into separate maps allows the patching mechanism to quickly determine which values have changed without iterating through a large array of attribute definitions. The introduction of the `key` field is mandatory for efficiently handling additions, removals, and reordering within lists of children.
