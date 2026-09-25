import SwiftUI

/// The moment before the Verse loads: drifting stars, an orbiting planet,
/// and the wordmark the site uses.
struct SplashView: View {
    @State private var appear = false
    private let teal = Color(red: 0.31, green: 0.87, blue: 0.75)

    var body: some View {
        ZStack {
            RadialGradient(
                colors: [Color(red: 0.05, green: 0.24, blue: 0.27), Color(red: 0.04, green: 0.08, blue: 0.15)],
                center: .top, startRadius: 20, endRadius: 700
            )
            .ignoresSafeArea()

            Starfield().ignoresSafeArea()

            VStack(spacing: 22) {
                OrbitMark(color: teal)
                    .frame(width: 120, height: 120)
                    .scaleEffect(appear ? 1 : 0.6)
                    .opacity(appear ? 1 : 0)

                VStack(spacing: 10) {
                    Text("POWERED BY CREATORS, OWNED BY PLAYERS")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .tracking(3)
                        .foregroundStyle(.white.opacity(0.45))
                    Text("VIBEVERSE")
                        .font(.system(size: 52, weight: .black, design: .default))
                        .tracking(-1.5)
                        .foregroundStyle(LinearGradient(
                            colors: [.white, Color(white: 0.72), .white],
                            startPoint: .top, endPoint: .bottom))
                        .shadow(color: teal.opacity(0.35), radius: 18)
                }
                .offset(y: appear ? 0 : 16)
                .opacity(appear ? 1 : 0)

                LoadingBar(color: teal)
                    .frame(width: 140, height: 3)
                    .padding(.top, 12)
                    .opacity(appear ? 1 : 0)
            }
        }
        .onAppear {
            withAnimation(.spring(response: 0.8, dampingFraction: 0.7)) { appear = true }
        }
    }
}

/// A planet with a tilted ring and a moon riding the orbit.
private struct OrbitMark: View {
    let color: Color

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let angle = t * 1.4
            ZStack {
                Circle()
                    .fill(RadialGradient(colors: [color.opacity(0.9), color.opacity(0.25)],
                                         center: .init(x: 0.35, y: 0.3), startRadius: 2, endRadius: 40))
                    .frame(width: 54, height: 54)
                    .shadow(color: color.opacity(0.7), radius: 20)
                Ellipse()
                    .stroke(color.opacity(0.8), lineWidth: 3)
                    .frame(width: 118, height: 40)
                    .rotationEffect(.degrees(-20))
                Circle()
                    .fill(.white)
                    .frame(width: 10, height: 10)
                    .shadow(color: .white, radius: 6)
                    .offset(x: cos(angle) * 59, y: sin(angle) * 20)
                    .rotationEffect(.degrees(-20))
                    .zIndex(sin(angle) > 0 ? 1 : -1)
            }
        }
    }
}

/// Stars that twinkle and drift slowly upward.
private struct Starfield: View {
    private let stars: [(x: Double, y: Double, r: Double, phase: Double, speed: Double)] = (0..<140).map { _ in
        (Double.random(in: 0...1), Double.random(in: 0...1), Double.random(in: 0.4...1.6),
         Double.random(in: 0...(2 * .pi)), Double.random(in: 0.004...0.02))
    }

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                for s in stars {
                    let y = (s.y - t * s.speed).truncatingRemainder(dividingBy: 1)
                    let py = (y < 0 ? y + 1 : y) * size.height
                    let alpha = 0.35 + 0.65 * (0.5 + 0.5 * sin(t * 2 + s.phase))
                    let rect = CGRect(x: s.x * size.width, y: py, width: s.r * 2, height: s.r * 2)
                    ctx.fill(Path(ellipseIn: rect), with: .color(.white.opacity(alpha * 0.8)))
                }
            }
        }
    }
}

/// A teal glint sweeping across a thin track.
private struct LoadingBar: View {
    let color: Color
    @State private var x: CGFloat = -1

    var body: some View {
        GeometryReader { geo in
            Capsule().fill(.white.opacity(0.1))
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(LinearGradient(colors: [.clear, color, .clear], startPoint: .leading, endPoint: .trailing))
                        .frame(width: geo.size.width * 0.45)
                        .offset(x: x * geo.size.width)
                }
                .clipShape(Capsule())
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: false)) { x = 1 }
        }
    }
}
