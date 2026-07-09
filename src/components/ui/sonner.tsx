import { useTheme } from "next-themes";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Every toast gets a ✕ to dismiss, and swipes away on touch.
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background/80 group-[.toaster]:backdrop-blur-xl group-[.toaster]:text-foreground group-[.toaster]:border-white/10 group-[.toaster]:rounded-2xl group-[.toaster]:shadow-[0_10px_40px_rgba(0,0,0,0.45)]",
          title: "group-[.toast]:font-heading group-[.toast]:font-semibold group-[.toast]:tracking-wide",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground group-[.toast]:rounded-full",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground group-[.toast]:rounded-full",
          closeButton:
            "group-[.toast]:bg-background/80 group-[.toast]:border-white/15 group-[.toast]:text-foreground/70 group-[.toast]:hover:text-foreground group-[.toast]:hover:bg-background",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
