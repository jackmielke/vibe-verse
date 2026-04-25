import { motion } from "framer-motion";
import { Zap } from "lucide-react";

const COMMUNITY_POSTS = [
  {
    id: 1,
    author: "Jake M.",
    text: "Anyone down for a hike to the ridge? Meeting at The Grove in 15 min 🥾",
    time: "2 min ago",
    likes: 5,
  },
  {
    id: 2,
    author: "Priya S.",
    text: "Lost my water bottle at the Hacker House — blue Hydroflask. DM me if found!",
    time: "8 min ago",
    likes: 2,
  },
  {
    id: 3,
    author: "Leo C.",
    text: "The stars are INSANE tonight. Heading to the Pool Deck with a telescope 🔭",
    time: "15 min ago",
    likes: 14,
  },
];

export default function CommunityPanel() {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {COMMUNITY_POSTS.map((post, i) => (
        <motion.div
          key={post.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className="rounded-xl border border-border p-3.5 hover:border-primary/20 transition-colors"
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="font-heading text-xs font-semibold text-foreground">{post.author}</p>
              <p className="text-sm text-foreground/80 mt-1">{post.text}</p>
            </div>
          </div>
          <div className="flex items-center justify-between mt-2.5">
            <span className="text-[10px] text-muted-foreground">{post.time}</span>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Zap className="w-3 h-3 text-primary" />
              {post.likes}
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
