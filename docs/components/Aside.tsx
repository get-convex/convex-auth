import { Details, Summary } from "./details";

export function Aside({ title, children }) {
  return (
    <Details>
      <Summary>{title}</Summary>
      {children}
    </Details>
  );
}
