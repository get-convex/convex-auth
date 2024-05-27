import Image from "next/image";

export function Graphic({
  src,
  dark,
  ...props
}: React.ComponentProps<typeof Image> & {
  dark: React.ComponentProps<typeof Image>["src"];
}) {
  return (
    <>
      <Image src={src} {...props} width={500} className="mx-auto dark:hidden" />
      <Image
        src={dark}
        {...props}
        width={500}
        className="mx-auto hidden dark:block"
      />
    </>
  );
}
