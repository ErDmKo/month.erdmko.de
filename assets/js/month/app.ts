import {
    cleanHtml,
    domCreator,
    genClass,
    genProp,
    genRef,
    genTagDiv,
    genTagName,
    genText,
} from '@month/utils';
import { CONTROL_BUTTON } from './const';
import { render } from './game';

export const init = (ctx: Window, root: HTMLElement) => {
    const baseHTML: HTMLElement[] = Array.from(root.children) as HTMLElement[];
    const monthNames: Record<string, string> = {};
    Object.assign(root.style, {
        minHeight: '70vh',
    });

    for (const parentElem of baseHTML) {
        if (!parentElem.classList.contains('month')) {
            continue;
        }
        for (const childElem of parentElem.children) {
            if (
                childElem.nodeType === Node.ELEMENT_NODE &&
                'innerText' in childElem
            ) {
                const [no, name] = String(childElem.innerText).split(' ');
                if (Number.isNaN(parseInt(no))) {
                    continue;
                }
                monthNames[no] = name;
            }
        }
    }

    const back = (e: MouseEvent) => {
        cleanHtml(root);
        e.target?.removeEventListener('click', back);
        baseHTML.forEach((elem) => {
            root.appendChild(elem);
        });
    };

    const backButton = genTagName('button', [
        genProp('style', CONTROL_BUTTON),
        genProp('onclick', back),
        genText('Выйти из тренажера'),
    ]);

    const runButtonTemplate = genTagName('button', [
        genRef(),
        genProp('style', CONTROL_BUTTON),
        genText('Запустить тренажер'),
        genProp('onclick', () => {
            cleanHtml(root);
            const template = genTagDiv(
                [genClass('month-game')],
                [
                    genTagName('h3', [genText('Тренажер запоминания месяцов')]),
                    genTagDiv([
                        genProp('style', {
                            maxWidth: '500px',
                            margin: '0 auto',
                        }),
                        genRef(),
                    ]),
                    backButton,
                ]
            );
            const [renderRoot] = domCreator(ctx, root, template);
            render(ctx, monthNames, renderRoot);
        }),
    ]);

    const [button] = domCreator(ctx, root, runButtonTemplate);

    baseHTML.push(button);
};
