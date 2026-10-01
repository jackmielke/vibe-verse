/**
 * /terms and /privacy — the two plain pages the App Store listing links to.
 *
 * Same words on the website and in the app: the iOS shell's TermsGate links
 * here, and App Review reads them. Keep them short and true; if the app starts
 * collecting something new, it goes in the list below the same day.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

const CONTACT = "jackcmielke@gmail.com";
const UPDATED = "30 September 2026";

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] w-full bg-background text-foreground">
      <main className="mx-auto max-w-2xl px-4 pb-20 pt-20 sm:px-6">
        <h1 className="font-heading text-3xl font-black tracking-tight">{title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">Vibe Verse · last updated {UPDATED}</p>
        <div className="mt-8 space-y-6 text-sm leading-relaxed text-foreground/85 [&_h2]:mb-2 [&_h2]:font-heading [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-foreground [&_li]:ml-4 [&_li]:list-disc [&_ul]:space-y-1.5">
          {children}
        </div>
        <p className="mt-12 border-t border-border/40 pt-6 text-xs text-muted-foreground">
          <Link to="/terms" className="hover:underline">Terms</Link>
          {" · "}
          <Link to="/privacy" className="hover:underline">Privacy</Link>
          {" · "}
          <Link to="/" className="hover:underline">Back to the worlds</Link>
        </p>
      </main>
    </div>
  );
}

const Mail = () => (
  <a href={`mailto:${CONTACT}`} className="text-primary hover:underline">
    {CONTACT}
  </a>
);

export function Terms() {
  return (
    <Page title="Community terms">
      <section>
        <p>
          The Vibe Verse is a collection of games and worlds, some of them multiplayer. By using it you agree
          to these terms. They apply in addition to Apple's standard{" "}
          <a
            href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/"
            className="text-primary hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            Licensed Application End User License Agreement
          </a>
          , which governs the iOS app.
        </p>
      </section>
      <section>
        <h2>Zero tolerance</h2>
        <p>
          There is no tolerance for objectionable content or abusive users. Do not post or say anything
          harassing, hateful, sexual, violent, threatening, or spam, and do not impersonate anybody.
        </p>
      </section>
      <section>
        <h2>Report and block</h2>
        <ul>
          <li>Tap the shield, a player's name, or a message to report it or block that player.</li>
          <li>Blocked players disappear for you immediately.</li>
          <li>Every report is reviewed within 24 hours.</li>
          <li>Offending content is removed, and the player who posted it is removed from the Vibe Verse.</li>
        </ul>
      </section>
      <section>
        <h2>Your account</h2>
        <p>
          An account is optional. You can play as a guest. If you make one, you can ask for it and everything
          linked to it to be deleted at any time by writing to <Mail />.
        </p>
      </section>
      <section>
        <h2>Contact</h2>
        <p>
          Questions, reports, or appeals: <Mail />.
        </p>
      </section>
    </Page>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy">
      <section>
        <h2>What we collect</h2>
        <ul>
          <li>
            <b>Account email</b>, only if you choose to sign in. Playing as a guest needs no email.
          </li>
          <li>
            <b>Display name</b> you pick, shown to other players in multiplayer worlds.
          </li>
          <li>
            <b>A random device id</b>, stored on your device, used to apply fair-use limits to voice features.
          </li>
          <li>
            <b>Gameplay presence</b>: in multiplayer worlds, your position, character and name are broadcast in
            real time to other players in the same world while you are in it.
          </li>
          <li>
            <b>Voice audio</b>: when you start the Magician's voice mode, your microphone audio is sent to OpenAI
            to be understood and answered. Nothing is recorded until you start it.
          </li>
          <li>
            <b>Reports</b> you file, including what you reported and why, so they can be reviewed.
          </li>
        </ul>
      </section>
      <section>
        <h2>What we do not do</h2>
        <ul>
          <li>No ads.</li>
          <li>No selling or sharing your data with advertisers or data brokers.</li>
          <li>No tracking across other apps or websites.</li>
        </ul>
      </section>
      <section>
        <h2>Deleting your data</h2>
        <p>
          Write to <Mail /> and we will delete your account and the data linked to it.
        </p>
      </section>
    </Page>
  );
}
