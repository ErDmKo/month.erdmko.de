import {
    genTagName,
    cleanHtml,
    domCreator,
    domDispose,
    DomScope,
    genClass,
    genOn,
    genProp,
    genRef,
} from '@month/utils';
import { $month } from '@month/gen/styles';
import { CONTROL_BUTTON } from './const';
import { render } from './game';

const GAME_ROOT_STYLE: Partial<CSSStyleDeclaration> = {
    maxWidth: '500px',
    margin: '0 auto',
};

export const init = (ctx: Window, root: HTMLElement) => {
    const baseHTML: HTMLElement[] = ctx.Array.from(
        root.children
    ) as HTMLElement[];
    const monthNames: Record<string, string> = {};
    let activeScope: DomScope = [];

    Object.assign(root.style, {
        minHeight: '70vh',
    });

    for (const parentElem of baseHTML) {
        if (!parentElem.classList.contains($month)) {
            continue;
        }
        for (const childElem of ctx.Array.from(parentElem.children)) {
            if (
                childElem.nodeType === Node.ELEMENT_NODE &&
                'innerText' in childElem
            ) {
                const [no, name] = String(
                    (childElem as HTMLElement).innerText
                ).split(' ');
                if (Number.isNaN(parseInt(no))) {
                    continue;
                }
                monthNames[no] = name;
            }
        }
    }

    const back = () => {
        domDispose(activeScope);
        activeScope = [];
        cleanHtml(root);
        baseHTML.forEach((elem) => {
            root.appendChild(elem);
        });
    };

    const backButton = genTagName(
        'button',
        [genProp('style', CONTROL_BUTTON), genOn('click', back)],
        ['Выйти из тренажера']
    );

    const runButtonTemplate = genTagName(
        'button',
        [
            genRef(),
            genProp('style', CONTROL_BUTTON),
            genOn('click', () => {
                domDispose(activeScope);
                activeScope = [];
                cleanHtml(root);
                const template = genTagName(
                    'div',
                    [genClass('month-game')],
                    [
                        genTagName('h3', [], ['Тренажер запоминания месяцов']),
                        genTagName('div', [
                            genProp('style', GAME_ROOT_STYLE),
                            genRef(),
                        ]),
                        backButton,
                    ]
                );
                const [renderRoot] = domCreator(
                    ctx,
                    root,
                    template,
                    activeScope
                );
                const gameScope = render(ctx, monthNames, renderRoot);
                activeScope.push(() => domDispose(gameScope));
            }),
        ],
        ['Запустить тренажер']
    );

    const [runButton] = domCreator(ctx, root, runButtonTemplate);

    baseHTML.push(runButton);
};
