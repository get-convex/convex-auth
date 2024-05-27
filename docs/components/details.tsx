import { Collapse } from "nextra-theme-docs";
import type { Dispatch, SetStateAction } from "react";
import {
  Children,
  ComponentProps,
  ReactElement,
  ReactNode,
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import cn from "clsx";

const DetailsContext = createContext<Dispatch<SetStateAction<boolean>>>(
  (v) => v
);

export const useDetails = () => useContext(DetailsContext);

export const DetailsProvider = DetailsContext.Provider;

const findSummary = (children: ReactNode) => {
  let summary: ReactNode = null;
  const restChildren: ReactNode[] = [];

  Children.forEach(children, (child, index) => {
    if (child && (child as ReactElement).type === Summary) {
      summary ||= child;
      return;
    }

    let c = child;
    if (
      !summary &&
      child &&
      typeof child === "object" &&
      (child as ReactElement).type !== Details &&
      "props" in child &&
      child.props
    ) {
      const result = findSummary(child.props.children);
      summary = result[0];
      c = cloneElement(child, {
        ...child.props,
        children: (result[1] as any)?.length ? result[1] : undefined,
        key: index,
      });
    }
    restChildren.push(c);
  });

  return [summary, restChildren];
};

export const Details = ({
  children,
  open,
  ...props
}: ComponentProps<"details">): ReactElement => {
  const [openState, setOpen] = useState(!!open);
  const [summary, restChildren] = findSummary(children);

  // To animate the close animation we have to delay the DOM node state here.
  const [delayedOpenState, setDelayedOpenState] = useState(openState);
  useEffect(() => {
    if (openState) {
      setDelayedOpenState(true);
    } else {
      const timeout = setTimeout(() => setDelayedOpenState(openState), 500);
      return () => clearTimeout(timeout);
    }
  }, [openState]);

  return (
    <details
      className="nx-my-4 nx-rounded nx-border nx-border-gray-200 nx-bg-white nx-p-2 nx-shadow-sm first:nx-mt-0 dark:nx-border-neutral-800 dark:nx-bg-neutral-900"
      {...props}
      open={delayedOpenState}
      {...(openState && { "data-expanded": true })}
    >
      <DetailsProvider value={setOpen}>{summary}</DetailsProvider>
      <Collapse isOpen={openState} className="px-2 pt-6 pb-1">
        {restChildren}
      </Collapse>
    </details>
  );
};
export const Summary = (props: ComponentProps<"summary">): ReactElement => {
  const setOpen = useDetails();
  return (
    <summary
      className={cn(
        "nx-flex nx-items-center nx-cursor-pointer nx-list-none nx-p-1 nx-transition-colors hover:nx-bg-gray-100 dark:hover:nx-bg-neutral-800",
        "before:nx-mr-1 before:nx-inline-block before:nx-transition-transform before:nx-content-[''] dark:before:nx-invert before:nx-shrink-0",
        "rtl:before:nx-rotate-180 [[data-expanded]>&]:before:nx-rotate-90"
      )}
      {...props}
      onClick={(e) => {
        e.preventDefault();
        setOpen((v) => !v);
      }}
    />
  );
};
